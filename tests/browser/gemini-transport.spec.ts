import { test, expect } from "@playwright/test";

test("Gemini PCM uses the real browser audio worklets and closes cleanly", async ({
  page,
}) => {
  let inputPackets = 0;
  await page.routeWebSocket("**/pcm-smoke", (socket) => {
    socket.send(JSON.stringify({ type: "session.started" }));
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "session.audio.append") {
        expect(message.rate).toBe(16000);
        expect(Buffer.from(message.data, "base64").length).toBe(1280);
        inputPackets++;
      }
      if (message.type === "session.commentary.append") {
        const audio = Buffer.alloc(24000);
        for (let i = 0; i < 12000; i++)
          audio.writeInt16LE(Math.round(Math.sin(i / 20) * 12000), i * 2);
        socket.send(JSON.stringify({ type: "session.output.started" }));
        socket.send(
          JSON.stringify({
            type: "session.audio.delta",
            data: audio.toString("base64"),
            rate: 24000,
          }),
        );
        socket.send(
          JSON.stringify({
            type: "session.output_transcript.delta",
            delta: "A spoken answer.",
          }),
        );
      }
      if (message.type === "session.close")
        socket.send(
          JSON.stringify({ type: "session.closed", usage: { seconds: 1 } }),
        );
    });
  });
  await page.goto("/");
  const result = await page.evaluate(async () => {
    // Vite transpiles the same module used by the app. The fixture supplies a
    // synthetic source, leaving the user's real microphone untouched.
    const { LiveConnection } = await import(
      /* @vite-ignore */ "/src/live.ts" as string
    );
    const context = new AudioContext(),
      oscillator = context.createOscillator(),
      stream = context.createMediaStreamDestination();
    oscillator.connect(stream);
    oscillator.start();
    await context.resume();
    const output: boolean[] = [],
      captions: string[] = [],
      errors: string[] = [];
    let ready = false,
      finalized = false;
    const live = new LiveConnection({
      onReady: () => {
        ready = true;
      },
      onOutput: (active: boolean) => output.push(active),
      onTranscript: (_role: string, text: string) => captions.push(text),
      onDelegation: () => {},
      onError: (e: string) => errors.push(e),
      onClose: (done: boolean) => {
        finalized = done;
      },
    });
    await live.connect(stream.stream, async (_sdp: string, pcm: boolean) => {
      if (!pcm) throw Error("PCM capability missing");
      return {
        transport: { sdp: "", websocketUrl: "ws://127.0.0.1:5173/pcm-smoke" },
      };
    });
    live.input(true);
    live.prepareOutput();
    live.append("commentary", "A spoken answer.");
    await new Promise((resolve) => setTimeout(resolve, 250));
    const held = await live.diagnostics();
    live.mute(false);
    await new Promise((resolve) => setTimeout(resolve, 800));
    await live.close();
    oscillator.stop();
    await context.close();
    return { ready, finalized, output, captions, errors, held };
  });
  expect(result.errors).toEqual([]);
  expect(result.ready).toBe(true);
  expect(result.held.output.bufferedMs).toBeGreaterThan(400);
  expect(result.output).toContain(true);
  expect(result.captions.join("")).toBe("A spoken answer.");
  expect(inputPackets).toBeGreaterThan(2);
  expect(result.finalized).toBe(true);
});
