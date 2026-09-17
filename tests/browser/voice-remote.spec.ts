import { test, expect, type Page } from "@playwright/test";
import { mockPlayer } from "./remote-fixture";
import { LiveIntent } from "../../backend/src/live-intent";
import type { LiveControlEvent } from "@aside/engine/contracts";

test.use({ locale: "en-US" });
async function setupRemote(page: Page, debug = false) {
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
                controller.close();
              },
              { once: true },
            );
          },
          cancel() {
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
        answer: async (q) => {
          inputs.push(q);
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
      json: {
        session: { id: "test-live" },
        transport: { sdp: answer },
        control: true,
      },
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
    acknowledgements,
    transcriptions: () => transcriptions,
    questionRequests: () => questionRequests,
  };
}

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
