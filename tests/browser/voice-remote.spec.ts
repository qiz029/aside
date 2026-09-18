import { test, expect, type Page } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mockPlayer } from "./remote-fixture";
import { LiveIntent } from "../../backend/src/live-intent";
import { QuestionService } from "../../backend/src/question-service";
import type {
  LiveControlEvent,
  QuestionRequest,
  QuestionResult,
} from "@aside/engine/contracts";

test.use({ locale: "en-US", launchOptions: { args: ["--mute-audio"] } });
async function setupRemote(
  page: Page,
  debug = false,
  respond?: (
    q: QuestionRequest,
    accept: () => boolean,
  ) => QuestionResult | Promise<QuestionResult>,
  acknowledgeClose = true,
  origin = "",
) {
  await mockPlayer(page);
  let transcriptions = 0,
    questionRequests = 0,
    timeline = 0;
  const inputs: any[] = [],
    errors: string[] = [],
    acknowledgements: any[] = [];
  let intent: LiveIntent;
  let emitted = Promise.resolve();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("close", () => intent?.close());
  const emit = (event: LiveControlEvent) => {
    emitted = emitted
      .then(() =>
        page.evaluate(
          (e) => (window as any).remotePush?.(JSON.stringify(e) + "\n"),
          event,
        ),
      )
      .catch(() => {});
  };
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
          autoResumeMs: 3000,
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
  await page.route("**/api/episodes/*/question", (route) => {
    questionRequests++;
    return route.fulfill({
      status: 500,
      json: { error: "Voice must not submit question requests" },
    });
  });
  await page.route("**/api/episodes/*/live-control", (route) => {
    const update = route.request().postDataJSON();
    if (update.acknowledgement) acknowledgements.push(update.acknowledgement);
    intent.update(update.player, update.acknowledgement);
    return route.fulfill({ json: { ok: true } });
  });
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (
        String(input).includes("/live-control?") &&
        (!init?.method || init.method === "GET")
      ) {
        const encoder = new TextEncoder();
        let streamClosed = false;
        const stream = new ReadableStream({
          start(controller) {
            (window as any).remotePush = (line: string) =>
              controller.enqueue(encoder.encode(line));
            controller.enqueue(
              encoder.encode('{"type":"ready","sessionId":"test-live"}\n'),
            );
            init?.signal?.addEventListener(
              "abort",
              () => {
                (window as any).remotePush = undefined;
                if (!streamClosed) {
                  streamClosed = true;
                  controller.close();
                }
              },
              { once: true },
            );
          },
          cancel() {
            streamClosed = true;
            (window as any).remotePush = undefined;
          },
        });
        return Promise.resolve(
          new Response(stream, {
            headers: { "Content-Type": "application/x-ndjson" },
          }),
        );
      }
      return originalFetch(input, init);
    };
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: async () => {
        const ctx = new AudioContext(),
          gain = ctx.createGain(),
          osc = ctx.createOscillator(),
          dest = ctx.createMediaStreamDestination();
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
    const { sdp, control } = route.request().postDataJSON();
    expect(control).toBeTruthy();
    intent = new LiveIntent(
      control.player,
      [],
      {
        // This substitutes only the model. Scheduling and state/ack handling use
        // the production server coordinator; it never receives browser captions.
        answer: async (q, _signal, accept) => {
          inputs.push(q);
          if (respond) return respond(q, accept);
          const text = q.history.at(-1)!.text.toLowerCase();
          const commands =
            text.includes("dinner") ||
            text.includes("don't") ||
            text.includes("honey")
              ? undefined
              : text.includes("slower")
                ? [{ type: "adjust_rate", direction: "slower" }]
                : text.includes("resume")
                  ? [{ type: "play" }]
                  : text.includes("pause") || text.includes("wait")
                    ? [{ type: "pause" }]
                    : undefined;
          return {
            revision: q.revision,
            answer: "",
            sources: [],
            tools: [],
            ...(commands
              ? {
                  action: "player_control",
                  commandId: crypto.randomUUID(),
                  commands,
                }
              : { action: "ignore" }),
          } as any;
        },
        emit,
        context: () => {},
        now: Date.now,
        after: (ms, run) => {
          const timer = setTimeout(run, ms);
          return () => clearTimeout(timer);
        },
      },
      debug,
    );
    const answer = await page.evaluate(
      async ({ offer, acknowledgeClose }) => {
        const peer = new RTCPeerConnection();
        Object.assign(window, { remotePeer: peer });
        const ctx = new AudioContext(),
          osc = ctx.createOscillator(),
          gain = ctx.createGain(),
          dest = ctx.createMediaStreamDestination();
        gain.gain.value = 0;
        osc.connect(gain).connect(dest);
        osc.start();
        await ctx.resume();
        for (const track of dest.stream.getTracks())
          peer.addTrack(track, dest.stream);
        Object.assign(window, { remoteOutput: { ctx, gain } });
        peer.ondatachannel = ({ channel }) => {
          Object.assign(window, { remoteChannel: channel });
          channel.onopen = () =>
            channel.send(JSON.stringify({ type: "session.started" }));
          channel.onmessage = ({ data }) => {
            if (acknowledgeClose && JSON.parse(data).type === "session.close")
              channel.send(
                JSON.stringify({
                  type: "session.closed",
                  usage: { seconds: 3 },
                }),
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
      },
      { offer: sdp, acknowledgeClose },
    );
    await route.fulfill({
      json: {
        session: { id: "test-live" },
        transport: { sdp: answer },
        control: true,
      },
    });
  });
  await page.goto(`${origin}/?episode=remote-a${debug ? "&debug" : ""}`);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).remoteChannel?.readyState))
    .toBe("open");
  await expect(page.getByRole("status", { includeHidden: true })).toContainText(
    "Voice conversation",
  );
  const audio = page.locator("audio");
  await expect
    .poll(() => audio.evaluate((a: HTMLAudioElement) => a.paused))
    .toBe(false);
  const speak = async (deltas: string[], captions = true) => {
    timeline += 2500;
    for (const [i, delta] of deltas.entries()) {
      const event = {
        type: "session.input_transcript.delta",
        delta,
        start_ms: timeline + i * 100,
        end_ms: timeline + (i + 1) * 100,
      };
      intent.receive(event);
      if (captions)
        await page.evaluate(
          (e) => (window as any).remoteChannel.send(JSON.stringify(e)),
          event,
        );
    }
  };
  return {
    audio,
    inputs,
    errors,
    speak,
    async expire() {
      emit({
        type: "error",
        error:
          "Voice session time limit reached. Please reconnect the microphone to keep talking.",
      });
      await emitted;
    },
    async reply(text: string, prefix = "") {
      if (prefix)
        await page.evaluate(
          (delta) =>
            (window as any).remoteChannel.send(
              JSON.stringify({
                type: "session.output_transcript.delta",
                delta,
              }),
            ),
          prefix,
        );
      await page.evaluate(() => {
        const { ctx, gain } = (window as any).remoteOutput;
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
      });
      await expect
        .poll(
          async () =>
            JSON.parse(
              (await page
                .getByRole("region", { name: "Voice diagnostics" })
                .locator("pre")
                .textContent())!,
            ).session?.spokenReply?.state,
        )
        .toBe("speaking");
      await page.evaluate(
        (t) =>
          (window as any).remoteChannel.send(
            JSON.stringify({
              type: "session.output_transcript.delta",
              delta: t,
            }),
          ),
        text,
      );
      await page.evaluate(() => {
        const { ctx, gain } = (window as any).remoteOutput;
        gain.gain.setValueAtTime(0, ctx.currentTime);
      });
      await expect
        .poll(
          async () =>
            JSON.parse(
              (await page
                .getByRole("region", { name: "Voice diagnostics" })
                .locator("pre")
                .textContent())!,
            ).session?.spokenReply?.state,
        )
        .toBe("quiet");
    },
    acknowledgements,
    transcriptions: () => transcriptions,
    questionRequests: () => questionRequests,
  };
}

test("the voice can respond while its full backend answer remains unresolved", async ({
  page,
}) => {
  let finish!: () => void;
  let answerReady = false;
  const phases: string[] = [];
  const service = new QuestionService({
    reply: async (input) => {
      if (input.toolChoice === "required") {
        phases.push("admission");
        return {
          id: "admitted",
          answer: "",
          calls: [{ id: "accept", name: "accept_question", arguments: "{}" }],
          sources: [],
          searchedWeb: false,
        };
      }
      phases.push("answer");
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      answerReady = true;
      return {
        id: "answer",
        answer: "Here is the explanation.",
        calls: [],
        sources: [],
        searchedWeb: false,
      };
    },
  });
  const s = await setupRemote(page, true, (q, accept) =>
    service.answer(
      {
        version: "1",
        source: "demo",
        summary: "",
        hostStyle: "",
        speakers: [],
        voice: "feminine",
        voiceReason: "test",
        anchors: [],
        passages: [],
      },
      q,
      undefined,
      undefined,
      undefined,
      undefined,
      accept,
    ),
  );
  await page.locator(".debug-toggle").click();
  await s.speak(["Why is he called Ah Q?"]);
  await expect.poll(() => s.acknowledgements.length).toBe(1);
  expect(phases).toEqual(["admission", "answer"]);
  expect(answerReady).toBe(false);
  await s.reply("Let me think about that.");
  await expect(page.locator(".message.assistant p")).toHaveText(
    "Let me think about that.",
  );
  expect(
    answerReady,
    "the full answer is deliberately held until speech is observable",
  ).toBe(false);
  expect(await s.audio.evaluate((a: HTMLAudioElement) => a.paused)).toBe(true);
  finish();
  await expect.poll(() => answerReady).toBe(true);
  await s.reply(" Here is the explanation.");
  await expect(page.locator(".message p")).toHaveText([
    "Why is he called Ah Q?",
    "Let me think about that. Here is the explanation.",
  ]);
  expect(
    s.acknowledgements.length,
    "completion cannot start a duplicate turn",
  ).toBe(1);
  expect(s.questionRequests()).toBe(0);
  expect(s.errors).toEqual([]);
});

test("an interrupted reply and early progress stay on opposite sides of the new question", async ({
  page,
}) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const s = await setupRemote(page, true, async (q) => {
    if (q.history.at(-1)!.text.includes("为什么")) await pending;
    return {
      action: "answer",
      revision: q.revision,
      answer: "Explanation",
      sources: [],
      tools: [],
    };
  });
  await page.locator(".debug-toggle").click();
  await s.speak(["讲讲阿Q正传"]);
  await expect.poll(() => s.acknowledgements.length).toBe(1);
  await page.evaluate(() => {
    const { ctx, gain } = (window as any).remoteOutput;
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
  });
  const diagnostics = async () =>
    JSON.parse(
      (await page
        .getByRole("region", { name: "Voice diagnostics" })
        .locator("pre")
        .textContent())!,
    );
  await expect
    .poll(async () => (await diagnostics()).session?.spokenReply?.state)
    .toBe("speaking");
  const caption = (delta: string, start_ms: number) =>
    page.evaluate(
      (event) => (window as any).remoteChannel.send(JSON.stringify(event)),
      {
        type: "session.output_transcript.delta",
        delta,
        start_ms,
        end_ms: start_ms + 400,
      },
    );
  await caption("上一条回答", 3500);
  await expect(
    page.locator(".message.assistant .message-content p"),
  ).toHaveText("上一条回答");
  await s.speak(["阿Q为什么叫阿Q？"]);
  await expect.poll(() => s.inputs.length).toBe(2);
  await caption("我来查一下。", 6000);
  // Let the caption reach the UI while the backend is deliberately held.
  await page.waitForTimeout(200);
  await expect(page.locator(".message .message-content p")).toHaveText([
    "讲讲阿Q正传",
    "上一条回答",
  ]);
  release();
  await expect.poll(() => s.acknowledgements.length).toBe(2);
  await expect(page.locator(".message .message-content p")).toHaveText([
    "讲讲阿Q正传",
    "上一条回答",
    "阿Q为什么叫阿Q？",
    "我来查一下。",
  ]);
  await caption("这个名字……", 7000);
  await caption("的结尾。", 4200);
  await expect(page.locator(".message .message-content p")).toHaveText([
    "讲讲阿Q正传",
    "上一条回答的结尾。",
    "阿Q为什么叫阿Q？",
    "我来查一下。这个名字……",
  ]);
  expect(s.questionRequests()).toBe(0);
  expect(s.transcriptions()).toBe(0);
  expect(s.errors).toEqual([]);
  expect(await s.audio.evaluate((a: HTMLAudioElement) => a.paused)).toBe(true);
  await page.evaluate(() => {
    const { ctx, gain } = (window as any).remoteOutput;
    gain.gain.setValueAtTime(0, ctx.currentTime);
  });
});

test("a progress sentence, thinking pause and ignored bystander speech keep the podcast paused until requested", async ({
  page,
}) => {
  const s = await setupRemote(page, true, (q) => {
    const text = q.history.at(-1)!.text;
    return {
      action: text.includes("dinner")
        ? "ignore"
        : text.includes("resume")
          ? "resume"
          : "answer",
      revision: q.revision,
      answer: "The actual explanation",
      sources: [],
      tools: [],
    };
  });
  await page.locator(".debug-toggle").click();
  await s.speak(["Can you explain that?"]);
  await expect.poll(() => s.acknowledgements.length).toBe(1);
  await s.reply("Let me check that.");
  // Longer than the old three-second automatic-resume deadline. Media and
  // AudioWorklet clocks run in real time, so this gap is part of the scenario.
  await page.waitForTimeout(4000);
  expect(await s.audio.evaluate((a: HTMLAudioElement) => a.paused)).toBe(true);
  await s.speak(["Honey, what should we have for dinner?"]);
  await expect.poll(() => s.inputs.length).toBe(2);
  expect(s.inputs[1].conversation?.assistant?.state).toBe("quiet");
  await s.reply(" Here is what I found.");
  await expect
    .poll(
      async () =>
        JSON.parse(
          (await page
            .getByRole("region", { name: "Voice diagnostics" })
            .locator("pre")
            .textContent())!,
        ).session?.spokenReply?.text,
    )
    .toBe("Let me check that. Here is what I found.");
  expect(await s.audio.evaluate((a: HTMLAudioElement) => a.paused)).toBe(true);
  await s.speak(["Please resume the podcast"]);
  await expect
    .poll(() => s.audio.evaluate((a: HTMLAudioElement) => a.paused))
    .toBe(false);
  expect(s.questionRequests()).toBe(0);
  expect(s.errors).toEqual([]);
});

test("expiry during a spoken answer clears Answering and leaves podcast resume usable", async ({
  page,
}) => {
  const s = await setupRemote(page, true, (q) => ({
    action: "answer",
    revision: q.revision,
    answer: "A draft answer",
    sources: [],
    tools: [],
  }));
  await page.locator(".debug-toggle").click();
  await s.speak(["What does that mean?"]);
  await expect.poll(() => s.acknowledgements.length).toBe(1);
  await page.evaluate(() => {
    const { ctx, gain } = (window as any).remoteOutput;
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
  });
  await expect(page.locator(".status")).toContainText("Answering");
  await s.expire();
  await expect(page.locator(".status")).not.toContainText("Answering");
  await expect(page.getByRole("alert")).toContainText(
    "Voice session time limit reached",
  );
  await expect
    .poll(
      async () =>
        JSON.parse(
          (await page
            .getByRole("region", { name: "Voice diagnostics" })
            .locator("pre")
            .textContent())!,
        ).session?.spokenReply?.state,
    )
    .toBe("interrupted");
  await expect
    .poll(
      async () =>
        JSON.parse(
          (await page
            .getByRole("region", { name: "Voice diagnostics" })
            .locator("pre")
            .textContent())!,
        ).session?.status,
    )
    .toBe("off");
  await page.getByRole("button", { name: /^Keep listening/ }).click();
  await expect
    .poll(() => s.audio.evaluate((a: HTMLAudioElement) => a.paused))
    .toBe(false);
  await expect
    .poll(() => page.evaluate(() => (window as any).remoteChannel?.readyState))
    .toBe("open");
  expect(s.errors).toEqual([]);
});

test("reloading sends a server close even when the voice never acknowledges closing", async ({
  page,
  baseURL,
}) => {
  const received: unknown[] = [];
  // Unload keepalive requests outlive the page's interception callbacks. Use a
  // real same-origin HTTP receiver to prove the close survives page destruction.
  const server = createServer(async (request, response) => {
    if (request.url?.endsWith("/usage")) {
      let body = "";
      for await (const chunk of request) body += chunk;
      received.push(JSON.parse(body));
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end('{"ok":true}');
    } else if (request.url?.startsWith("/api/")) {
      response
        .writeHead(404, { "Content-Type": "application/json" })
        .end('{"error":"Test endpoint"}');
    } else {
      const upstream = await fetch(new URL(request.url!, baseURL));
      response.writeHead(upstream.status, {
        "Content-Type": upstream.headers.get("Content-Type") ?? "text/plain",
      });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await setupRemote(page, false, undefined, false, origin);
    await page.unroute("**/api/episodes/*/usage");
    await page.unroute("**/api/**");
    await page.reload();
    await expect
      .poll(() => received, { timeout: 1500 })
      .toEqual([
        { sessionId: "test-live", seconds: 0, finalized: false, closed: true },
      ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

for (const url of ["/episodes/remote-a?debug", "/?episode=remote-a&debug"])
  test(`diagnostics preserves its entry and stays passive at ${url}`, async ({
    page,
  }) => {
    await mockPlayer(page);
    let micRequests = 0;
    await page.exposeFunction("unexpectedMicrophone", () => {
      micRequests++;
    });
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
    expect(
      await page.locator("audio").evaluate((a: HTMLAudioElement) => a.paused),
    ).toBe(true);
  });

test("late punctuation and bystander recognition do not swallow an answer queued before audio starts", async ({
  page,
}) => {
  const prefix = "因为这些名目都不合，";
  const tail = "作者就用了正传。";
  const s = await setupRemote(page, true, (q) => {
    const latest = q.history.at(-1)!.text;
    return {
      action: latest.includes("Honey")
        ? "ignore"
        : latest.includes("continue")
          ? "resume"
          : "answer",
      revision: q.revision,
      answer: prefix + tail,
      sources: [],
      tools: [],
    };
  });
  await page.locator(".debug-toggle").click();
  await s.speak(["那为什么是正传呢"]);
  await expect.poll(() => s.acknowledgements.length).toBe(1);
  // Non-actionable caption fragments must not create an extra dialogue turn.
  await s.speak(['？"}']);
  // A real but unrelated utterance can be observed while the answer is queued.
  await s.speak(["Honey, what's for dinner?"]);
  await expect.poll(() => s.inputs.length).toBe(2);
  await s.reply(tail, prefix);
  await page.locator(".debug-toggle").click();
  await expect(page.getByRole("log")).toContainText(prefix + tail);
  await expect(page.getByRole("log")).not.toContainText('？"}');
  await s.speak(['？"}']);
  await s.speak(["OK, continue"]);
  await expect.poll(() => s.acknowledgements.length).toBe(2);
  expect(
    s.inputs.every((q) => /[\p{L}\p{N}]/u.test(q.history.at(-1)!.text)),
  ).toBe(true);
  expect(
    s.inputs.filter((q) => !q.history.at(-1)!.text.includes("Honey")),
  ).toHaveLength(2);
  expect(s.inputs.at(-1)!.history.slice(-3)).toEqual([
    { role: "user", text: "那为什么是正传呢" },
    { role: "assistant", text: prefix + tail },
    { role: "user", text: "OK, continue" },
  ]);
  await expect
    .poll(() => s.audio.evaluate((a: HTMLAudioElement) => a.paused))
    .toBe(false);
  expect(s.questionRequests()).toBe(0);
  expect(s.errors).toEqual([]);
});

for (const viewport of [
  { width: 1414, height: 1049 },
  { width: 1280, height: 650 },
  { width: 768, height: 900 },
  { width: 375, height: 667 },
])
  test(`expanded diagnostics keeps the player accessible at ${viewport.width}×${viewport.height}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await mockPlayer(page);
    await page.goto("/episodes/remote-a?debug");
    const toggle = page.locator(".debug-toggle");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".lower")).toBeHidden();
    await expect(
      page.getByRole("region", { name: "Voice diagnostics" }),
    ).toContainText("Microphone: off");
    const workspace = page.locator(".debug-workspace");
    await page.screenshot({
      path: testInfo.outputPath("diagnostics-overview.png"),
    });
    // Long input and expanded raw traces must scroll inside the workspace,
    // without moving the transport off-screen or underneath the trace.
    await workspace
      .locator("summary")
      .filter({ hasText: "Connection details" })
      .click();
    await workspace
      .locator("summary")
      .filter({ hasText: "Player events" })
      .click();
    await workspace
      .locator("blockquote")
      .first()
      .evaluate((el) => {
        el.textContent =
          "Long transcript without spaces: " + "testing".repeat(600);
      });
    const bounds = await workspace.boundingBox();
    const dock = await page.locator(".player-dock").boundingBox();
    expect(bounds).not.toBeNull();
    expect(dock).not.toBeNull();
    expect(bounds!.height).toBeGreaterThan(100);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(dock!.y);
    expect(dock!.y + dock!.height).toBeLessThanOrEqual(viewport.height);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(viewport.width);
    await expect(
      page.getByRole("button", { name: "Play", exact: true }),
    ).toBeInViewport();
    await workspace.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(
      page.getByRole("button", { name: "Play", exact: true }),
    ).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("diagnostics.png") });
    await toggle.click();
    await expect(page.locator(".lower")).toBeVisible();
    expect(
      await page.locator("audio").evaluate((a: HTMLAudioElement) => a.paused),
    ).toBe(true);
  });

for (const width of [1440, 320]) {
  test(`microphone feedback follows local audio before any model decision at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const s = await setupRemote(page);
    const feedback = page.getByRole("group", { name: "Microphone activity" });
    const center = feedback.locator("i").nth(3);
    const scale = () =>
      center.evaluate(
        (bar) => new DOMMatrixReadOnly(getComputedStyle(bar).transform).m22,
      );
    const input = (value: number) =>
      page.evaluate((value) => {
        const { gain, ctx } = (window as any).remoteMic;
        gain.gain.setValueAtTime(value, ctx.currentTime);
      }, value);
    await expect(feedback).toBeInViewport();
    await expect(feedback).toContainText("Microphone on");
    await expect.poll(scale).toBeLessThan(0.16);
    // Below the speech detector's threshold: visual feedback does not wait for VAD or NDJSON.
    await input(0.02);
    await expect(feedback).toHaveAttribute("data-hearing", "true");
    await expect(feedback).toContainText("Hearing audio");
    await expect.poll(scale).toBeGreaterThan(0.2);
    const soft = await scale();
    await input(0.12);
    await expect.poll(scale).toBeGreaterThan(soft + 0.25);
    expect(s.inputs).toHaveLength(0);
    expect(s.questionRequests()).toBe(0);
    expect(s.transcriptions()).toBe(0);
    expect(
      await s.audio.evaluate((audio: HTMLAudioElement) => audio.paused),
    ).toBe(false);
    const activityBox = (await feedback.boundingBox())!;
    const dockBox = (await page.locator(".player-dock").boundingBox())!;
    expect(activityBox.y + activityBox.height).toBeLessThan(dockBox.y);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: testInfo.outputPath("microphone-hearing.png"),
      fullPage: true,
    });
    await input(0);
    await expect(feedback).not.toHaveAttribute("data-hearing", "true");
    await expect(feedback).toContainText("Microphone on");
    await expect.poll(scale).toBeLessThan(0.16);
    // Reduced motion keeps a static state change instead of a fluctuating meter.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await input(0.03);
    await expect.poll(scale).toBe(0.65);
    await input(0.15);
    await expect.poll(scale).toBe(0.65);
    await input(0);
    await expect.poll(scale).toBe(0.15);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(feedback).toHaveCount(0);
    expect(s.errors).toEqual([]);
  });
}

test("diagnostics shows real local input frames, sending state and WebRTC byte counters", async ({
  page,
}) => {
  const { errors } = await setupRemote(page, true);
  await page.locator(".debug-toggle").click();
  const panel = page
    .getByRole("region", { name: "Voice diagnostics" })
    .locator("pre");
  const snapshot = async () =>
    JSON.parse((await panel.textContent())!).session?.voice;
  await expect
    .poll(async () => (await snapshot())?.microphone?.frames ?? 0)
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await snapshot())?.live?.inputEnabled)
    .toBe(true);
  await expect
    .poll(async () => (await snapshot())?.live?.connection)
    .toBe("connected");
  await page.evaluate(() => {
    const { gain, ctx } = (window as any).remoteMic;
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
  });
  await expect
    .poll(async () => (await snapshot())?.microphone?.rms ?? 0)
    .toBeGreaterThan(0.05);
  await expect
    .poll(
      async () =>
        (await snapshot())?.live?.audio?.find(
          (r: any) => r.type === "outbound-rtp",
        )?.bytesSent ?? 0,
    )
    .toBeGreaterThan(0);
  await expect(page.locator("pre.debug").last()).toContainText(
    "Live microphone sending: true",
  );
  await expect(page.locator("pre.debug").last()).toContainText(
    "Local speech started",
  );
  expect(errors).toEqual([]);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
});

test("debug separates browser captions, sideband reception and backend classification", async ({
  page,
}) => {
  const s = await setupRemote(page, true);
  await page.locator(".debug-toggle").click();
  const panel = page.getByRole("region", { name: "Voice diagnostics" });
  const recognition = async () =>
    JSON.parse((await panel.locator("pre").textContent())!).session
      ?.recognition;
  await s.speak(["Honey,", " ", "what's for dinner?"]);
  await expect
    .poll(async () => (await recognition())?.liveInputText)
    .toBe("Honey, what's for dinner?");
  await expect
    .poll(async () => (await recognition())?.submittedText)
    .toBe("Honey, what's for dinner?");
  await expect.poll(() => s.inputs.length).toBe(1);
  expect(s.questionRequests()).toBe(0);
  expect(await s.audio.evaluate((a: HTMLAudioElement) => a.paused)).toBe(false);
  await page.locator(".debug-toggle").click();
  await expect(page.getByRole("log")).toBeVisible();
  await expect(page.getByRole("log")).not.toContainText("dinner");
  expect(s.errors).toEqual([]);
});

test("sideband alone pauses through pushed NDJSON without browser transcript, VAD or delegation", async ({
  page,
}) => {
  const s = await setupRemote(page, true);
  await s.speak(["Wait", " ", "wait!"], false);
  await expect
    .poll(() => s.audio.evaluate((a: HTMLAudioElement) => a.paused))
    .toBe(true);
  expect(s.inputs).toHaveLength(1);
  expect(s.inputs[0].history.at(-1).text).toBe("Wait wait!");
  expect(s.questionRequests()).toBe(0);
  expect(s.transcriptions()).toBe(0);
  await expect.poll(() => s.acknowledgements.length).toBe(1);
  expect(s.errors).toEqual([]);
});

test("one stream handles rate, bystander speech, pause and resume without frontend intent requests", async ({
  page,
}) => {
  const s = await setupRemote(page);
  await s.speak(["A little slower please"]);
  await expect
    .poll(() => s.audio.evaluate((a: HTMLAudioElement) => a.playbackRate))
    .toBe(0.9);
  expect(await s.audio.evaluate((a: HTMLAudioElement) => a.paused)).toBe(false);
  await s.speak(["Honey, what should we have for dinner?"]);
  await expect.poll(() => s.inputs.length).toBe(2);
  expect(
    await s.audio.evaluate((a: HTMLAudioElement) => ({
      paused: a.paused,
      volume: a.volume,
    })),
  ).toEqual({ paused: false, volume: 1 });
  await s.speak(["Hey", " ", "could you pause the podcast?"]);
  await expect
    .poll(() => s.audio.evaluate((a: HTMLAudioElement) => a.paused))
    .toBe(true);
  await s.speak(["Please resume the podcast"]);
  await expect
    .poll(() => s.audio.evaluate((a: HTMLAudioElement) => a.paused))
    .toBe(false);
  expect(s.questionRequests()).toBe(0);
  expect(s.transcriptions()).toBe(0);
  expect(s.errors).toEqual([]);
});

for (const scenario of [
  { offer: "Shall I resume the podcast?", action: "resume" as const },
  {
    offer: "Would you like me to explain the distinction?",
    action: "answer" as const,
  },
])
  test(`a spoken yes follows the actual offer: ${scenario.action}`, async ({
    page,
  }) => {
    let turn = 0;
    const s = await setupRemote(page, true, (q) => {
      turn++;
      if (turn === 2) {
        expect(q.history.at(-2)).toEqual({
          role: "assistant",
          text: scenario.offer,
        });
        expect(q.history.at(-1)?.text).toBe("Yes");
        expect(q.conversation?.assistant?.state).toBe("quiet");
        expect(q.conversation?.playback.playback?.interrupted).toBe(true);
      }
      return {
        action: turn === 1 ? "answer" : scenario.action,
        revision: q.revision,
        answer: "A draft, not the spoken wording",
        sources: [],
        tools: [],
      };
    });
    await page.locator(".debug-toggle").click();
    await s.speak(["What does that mean?"]);
    await expect.poll(() => s.acknowledgements.length).toBe(1);
    await expect
      .poll(() => s.audio.evaluate((a: HTMLAudioElement) => a.paused))
      .toBe(true);
    await s.reply(scenario.offer);
    await s.speak(["Yes"]);
    await expect.poll(() => s.acknowledgements.length).toBe(2);
    await expect
      .poll(() => s.audio.evaluate((a: HTMLAudioElement) => a.paused))
      .toBe(scenario.action !== "resume");
    expect(s.questionRequests()).toBe(0);
    expect(s.errors).toEqual([]);
  });
