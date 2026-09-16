import { test, expect, type Page } from "@playwright/test";
import { mockPlayer } from "./remote-fixture";

test.use({ locale: "en-US" });

async function setupRemote(page: Page, debug = false) {
  await mockPlayer(page);
  let transcriptions = 0;
  const inputs: any[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/health", (route) =>
    route.fulfill({
      json: {
        liveConfigured: true,
        uploadsEnabled: false,
        microphone: {
          threshold: 0.025,
          minSpeechMs: 120,
          silenceMs: 160,
          vadEnabled: false,
        },
        voiceLifecycle: {
          preRollMs: 750,
          graceMs: 100,
          idleCloseMs: 60000,
          autoResumeMs: 0,
        },
      },
    }),
  );
  await page.route("**/api/episodes/*/usage", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await page.route("**/api/episodes/*/transcribe-question", (route) => {
    transcriptions++;
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected standalone transcription" },
    });
  });
  await page.route("**/api/episodes/*/question", async (route) => {
    const q = route.request().postDataJSON();
    inputs.push(q);
    const text = q.history.at(-1).text as string;
    const commands = text.includes("slower")
      ? [{ type: "adjust_rate", direction: "slower" }]
      : text.includes("pause") || /wait/i.test(text)
        ? [{ type: "pause" }]
        : text.includes("resume")
          ? [{ type: "play" }]
          : undefined;
    const result = {
      revision: q.revision,
      answer: "",
      sources: [],
      tools: [],
      ...(commands
        ? { action: "player_control", commandId: q.player.turnId, commands }
        : { action: "ignore" }),
    };
    await route.fulfill({
      contentType: "application/x-ndjson",
      body:
        JSON.stringify({
          type: "progress",
          revision: q.revision,
          phase: "working",
        }) +
        "\n" +
        JSON.stringify({ type: "result", result }) +
        "\n",
    });
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: async () => {
        const ctx = new AudioContext();
        const gain = ctx.createGain();
        const osc = ctx.createOscillator();
        const dest = ctx.createMediaStreamDestination();
        gain.gain.value = 0;
        osc.connect(gain).connect(dest);
        osc.start();
        await ctx.resume();
        Object.assign(window, { remoteMic: { gain, ctx } });
        return dest.stream;
      },
    });
  });
  await page.route("**/api/episodes/*/live", async (route) => {
    const { sdp } = route.request().postDataJSON();
    const answer = await page.evaluate(async (offer) => {
      const peer = new RTCPeerConnection();
      Object.assign(window, { remotePeer: peer });
      peer.ondatachannel = ({ channel }) => {
        Object.assign(window, { remoteChannel: channel });
        channel.onopen = () =>
          channel.send(JSON.stringify({ type: "session.started" }));
        channel.onmessage = ({ data }) => {
          if (JSON.parse(data).type === "session.close")
            channel.send(
              JSON.stringify({ type: "session.closed", usage: { seconds: 3 } }),
            );
        };
      };
      await peer.setRemoteDescription({ type: "offer", sdp: offer });
      await peer.setLocalDescription(await peer.createAnswer());
      if (peer.iceGatheringState !== "complete")
        await new Promise<void>((resolve) =>
          peer.addEventListener("icegatheringstatechange", () => {
            if (peer.iceGatheringState === "complete") resolve();
          }),
        );
      return peer.localDescription!.sdp;
    }, sdp);
    await route.fulfill({
      json: { session: { id: "test-live" }, transport: { sdp: answer } },
    });
  });
  await page.goto(`/?episode=remote-a${debug ? "&debug" : ""}`);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).remoteChannel?.readyState))
    .toBe("open");
  await expect(page.getByRole("status")).toContainText("Voice conversation");
  const audio = page.locator("audio");
  await expect
    .poll(() => audio.evaluate((a: HTMLAudioElement) => a.paused))
    .toBe(false);
  return { audio, inputs, errors, transcriptions: () => transcriptions };
}

for (const url of ["/episodes/remote-a?debug", "/?episode=remote-a&debug"])
  test(`diagnostics preserves its entry and stays passive at ${url}`, async ({ page }) => {
    await mockPlayer(page);
    let micRequests = 0;
    await page.exposeFunction("unexpectedMicrophone", () => { micRequests++; });
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        await (window as any).unexpectedMicrophone();
        throw Error("Debug must not start a microphone");
      };
    });
    await page.goto(url);
    await expect(page).toHaveURL(/\/episodes\/remote-a\?debug$/);
    await page.locator(".debug-toggle").click();
    const panel = page.getByRole("region", { name: "Voice diagnostics" });
    await expect(panel).toContainText('"status": "off"');
    expect(micRequests).toBe(0);
    expect(await page.locator("audio").evaluate((a: HTMLAudioElement) => a.paused)).toBe(true);
  });

test("diagnostics shows real local input frames, sending state and WebRTC byte counters", async ({ page }) => {
  const { errors } = await setupRemote(page, true);
  await page.locator(".debug-toggle").click();
  const panel = page.getByRole("region", { name: "Voice diagnostics" }).locator("pre");
  const snapshot = async () => JSON.parse((await panel.textContent())!).session?.voice;
  await expect.poll(async () => (await snapshot())?.microphone?.frames ?? 0).toBeGreaterThan(0);
  await expect.poll(async () => (await snapshot())?.live?.inputEnabled).toBe(true);
  await expect.poll(async () => (await snapshot())?.live?.connection).toBe("connected");
  await page.evaluate(() => {
    const { gain, ctx } = (window as any).remoteMic;
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
  });
  await expect.poll(async () => (await snapshot())?.microphone?.rms ?? 0).toBeGreaterThan(0.05);
  await expect.poll(async () => (await snapshot())?.live?.audio?.find((r: any) => r.type === "outbound-rtp")?.bytesSent ?? 0).toBeGreaterThan(0);
  await expect(page.locator("pre.debug").last()).toContainText("Live microphone sending: true");
  await expect(page.locator("pre.debug").last()).toContainText("Local speech started");
  expect(errors).toEqual([]);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
});

test("short Live input pauses through NDJSON without local onset or delegation", async ({
  page,
}) => {
  const { audio, inputs, transcriptions } = await setupRemote(page);
  // Leave the synthetic microphone silent: local onset must not gate Live input.
  await page.evaluate(() =>
    (window as any).remoteChannel.send(
      JSON.stringify({
        type: "session.input_transcript.delta",
        delta: "Wait, wait!",
      }),
    ),
  );
  await expect
    .poll(() => audio.evaluate((a: HTMLAudioElement) => a.paused))
    .toBe(true);
  expect(inputs).toHaveLength(1);
  expect(inputs[0].history.at(-1).text).toBe("Wait, wait!");
  expect(transcriptions()).toBe(0);
});

test("Live delegation streams NDJSON controls without pausing for incidental speech or rate changes", async ({
  page,
}) => {
  const { audio, inputs, errors, transcriptions } = await setupRemote(page);
  const speak = async (text: string, id: string) => {
    await page.evaluate(() => {
      const { gain, ctx } = (window as any).remoteMic;
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
    });
    // Drive actual AudioWorklet speech onset before delivering Live's transcript.
    await page.waitForTimeout(260);
    await page.evaluate(
      ({ text, id }) => {
        const channel = (window as any).remoteChannel;
        channel.send(
          JSON.stringify({
            type: "session.input_transcript.delta",
            delta: text,
          }),
        );
        channel.send(
          JSON.stringify({
            type: "session.delegation.created",
            delegation: { id, target: "client" },
          }),
        );
      },
      { text, id },
    );
  };
  const quiet = async () => {
    await page.evaluate(() => {
      const { gain, ctx } = (window as any).remoteMic;
      gain.gain.setValueAtTime(0, ctx.currentTime);
    });
    await page.waitForTimeout(350);
  };
  await speak("A little slower please", "slow");
  await expect
    .poll(() => audio.evaluate((a: HTMLAudioElement) => a.playbackRate))
    .toBe(0.9);
  await expect
    .poll(() => audio.evaluate((a: HTMLAudioElement) => a.paused))
    .toBe(false);
  expect(inputs[0].player.audibleSource).toBe("podcast");
  await quiet();
  await speak("Honey, what should we have for dinner?", "bystander");
  await expect.poll(() => inputs.length).toBe(2);
  await quiet();
  expect(
    await audio.evaluate((a: HTMLAudioElement) => ({
      paused: a.paused,
      volume: a.volume,
    })),
  ).toEqual({ paused: false, volume: 1 });
  await expect(page.getByRole("log")).not.toContainText("dinner");
  await speak("Please pause the podcast", "pause");
  await expect
    .poll(() => audio.evaluate((a: HTMLAudioElement) => a.paused))
    .toBe(true);
  await quiet();
  await speak("Please resume the podcast", "resume");
  await expect
    .poll(() => audio.evaluate((a: HTMLAudioElement) => a.paused))
    .toBe(false);
  expect(transcriptions()).toBe(0);
  expect(errors).toEqual([]);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
});
