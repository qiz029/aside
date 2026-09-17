import { test, expect } from "@playwright/test";
import { mockPlayer } from "./remote-fixture";

// No microphone capture or audible playback: both WebRTC peers use generated audio.
test.use({
  launchOptions: {
    args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"],
  },
});

test("WebRTC reply retains its real audio prefix while awaiting answer approval", async ({
  page,
}) => {
  await mockPlayer(page);
  await page.goto("/");
  await page.evaluate(async () => {
    const moduleUrl = "/src/live.ts";
    const { LiveConnection } = await import(moduleUrl);
    const source = new AudioContext();
    await source.resume();
    const mic = source.createMediaStreamDestination();
    const remote = source.createMediaStreamDestination();
    const oscillator = source.createOscillator();
    const gain = source.createGain();
    gain.gain.value = 0;
    oscillator.frequency.value = 440;
    oscillator.connect(gain).connect(remote);
    oscillator.start();
    const peer = new RTCPeerConnection();
    for (const track of remote.stream.getTracks())
      peer.addTrack(track, remote.stream);
    const h: any = {
      source,
      peer,
      gain,
      oscillator,
      samples: [],
      transcripts: [],
      outputEvents: [],
      errors: [],
    };
    const live = (h.live = new LiveConnection({
      onReady() {
        live.mute(true);
      },
      onOutput(active: boolean) {
        h.outputEvents.push(active);
      },
      onTranscript(role: string, text: string) {
        h.transcripts.push([role, text]);
      },
      onDelegation() {},
      onClose() {},
      onError(error: string) {
        h.errors.push(error);
      },
    }));
    peer.ondatachannel = ({ channel }) => {
      h.channel = channel;
      channel.onopen = () =>
        channel.send(JSON.stringify({ type: "session.started" }));
      channel.onmessage = ({ data }) => {
        if (JSON.parse(data).type === "session.close")
          channel.send(JSON.stringify({ type: "session.closed" }));
      };
    };
    await live.connect(mic.stream, async (sdp: string) => {
      await peer.setRemoteDescription({ type: "offer", sdp });
      await peer.setLocalDescription(await peer.createAnswer());
      if (peer.iceGatheringState !== "complete")
        await new Promise<void>((resolve) =>
          peer.addEventListener("icegatheringstatechange", () => {
            if (peer.iceGatheringState === "complete") resolve();
          }),
        );
      return { transport: { sdp: peer.localDescription!.sdp } };
    });
    // Tap the actual speaker path after the production output gate.
    await live.ctx.audioWorklet.addModule("/microphone-worklet.js");
    const tap = new AudioWorkletNode(live.ctx, "aside-capture");
    tap.port.onmessage = ({ data }) => h.samples.push(...data);
    live.output.connect(tap).connect(live.ctx.destination);
    Object.assign(window, { audioPrefixTest: h });
    live.prepareOutput();
    h.channel.send(
      JSON.stringify({
        type: "session.output_transcript.delta",
        delta: "Let me think. ",
      }),
    );
    gain.gain.value = 0.15;
  });
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await (window as any).audioPrefixTest.live.diagnostics()).output
            ?.bufferedMs ?? 0,
      ),
    )
    .toBeGreaterThan(500);
  const held = await page.evaluate(() => {
    const h = (window as any).audioPrefixTest;
    h.oscillator.frequency.value = 880; // The prefix stops arriving before we approve.
    return {
      peak: Math.max(0, ...h.samples.map(Math.abs)),
      events: h.outputEvents,
      transcripts: h.transcripts,
    };
  });
  expect(held).toEqual({ peak: 0, events: [], transcripts: [] });
  await page.waitForTimeout(250); // Ensure the new tone traverses the WebRTC jitter buffer.
  await page.evaluate(() => (window as any).audioPrefixTest.live.mute(false));
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).audioPrefixTest.outputEvents),
    )
    .toEqual([true]);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const h = (window as any).audioPrefixTest;
        return h.samples.filter((x: number) => Math.abs(x) > 0.005).length;
      }),
    )
    .toBeGreaterThan(48000);
  const result = await page.evaluate(async () => {
    const h = (window as any).audioPrefixTest;
    h.gain.gain.value = 0;
    const samples: number[] = h.samples;
    const start = samples.findIndex((x) => Math.abs(x) > 0.005);
    const rate = h.live.ctx.sampleRate;
    const power = (at: number, frequency: number) => {
      let re = 0,
        im = 0;
      for (let i = 0; i < 4096; i++) {
        re += samples[at + i] * Math.cos((2 * Math.PI * frequency * i) / rate);
        im += samples[at + i] * Math.sin((2 * Math.PI * frequency * i) / rate);
      }
      return re * re + im * im;
    };
    const result = {
      prefixRatio: power(start + 512, 440) / power(start + 512, 880),
      suffixRatio:
        power(samples.length - 8192, 880) / power(samples.length - 8192, 440),
      transcripts: h.transcripts,
      errors: h.errors,
    };
    await h.live.close();
    h.peer.close();
    await h.source.close();
    return result;
  });
  expect(result.prefixRatio).toBeGreaterThan(20);
  expect(result.suffixRatio).toBeGreaterThan(20);
  expect(result.transcripts).toEqual([["assistant", "Let me think. "]]);
  expect(result.errors).toEqual([]);
});
