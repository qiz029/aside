import { test, expect } from "@playwright/test";
import { FakeDelegatedLive } from "./delegation-fixture";
import type { LiveControlEvent } from "@aside/engine/contracts";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/episodes/demo-natural-resume/checkpoint", (route) =>
    route.fulfill({ json: { positionMs: 0, history: [] } }),
  );
});

test("transcript sentence cue seeks and starts playback in the bottom player", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: /给思考留一点空间/ }).click();
  const transcript = page.getByRole("region", { name: "文字稿" });
  const passages = (
    await (await page.request.get("/api/episodes/demo-natural-resume")).json()
  ).analysis.passages as { startMs: number }[];
  const line = transcript.locator(".transcript-line").nth(4);
  await line.scrollIntoViewIfNeeded();
  await line.hover();
  const jump = line.getByRole("button", { name: /从这句播放/ });
  await expect(jump).toHaveCSS("opacity", "1");
  await jump.click();
  await expect
    .poll(() =>
      page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.paused),
    )
    .toBe(false);
  await expect
    .poll(() =>
      page
        .locator("audio")
        .evaluate((audio: HTMLAudioElement) => audio.currentTime),
    )
    .toBeGreaterThanOrEqual(passages[4].startMs / 1000);
  await expect(transcript.locator('[aria-current="true"]')).toContainText(
    "你可以随时打断我",
  );
  const dock = page.locator(".player-dock");
  expect(
    await dock.evaluate((element) =>
      Math.abs(element.getBoundingClientRect().bottom - innerHeight),
    ),
  ).toBeLessThan(2);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  const mobileLine = transcript.locator(".transcript-line").nth(2);
  await mobileLine.locator("span").last().click();
  await expect(mobileLine).toHaveClass(/is-selected/);
  const mobileJump = mobileLine.getByRole("button", { name: /从这句播放/ });
  await expect(mobileJump).toHaveCSS("opacity", "1");
  await mobileJump.click();
  await expect
    .poll(() =>
      page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.paused),
    )
    .toBe(false);
  await expect
    .poll(() =>
      page
        .locator("audio")
        .evaluate((audio: HTMLAudioElement) => audio.currentTime),
    )
    .toBeGreaterThanOrEqual(passages[2].startMs / 1000);
  expect(
    await dock.evaluate((element) =>
      Math.abs(element.getBoundingClientRect().bottom - innerHeight),
    ),
  ).toBeLessThan(2);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("real demo playback, interruption, sentence rewind and responsive layout", async ({
  page,
}) => {
  await page.route("**/api/health", async (route) => {
    const r = await route.fetch();
    await route.fulfill({
      json: { ...(await r.json()), liveConfigured: true },
    });
  });
  await page.route("**/api/episodes/demo-natural-resume/checkpoint", (route) =>
    route.fulfill({
      json: {
        positionMs: 0,
        history: Array.from({ length: 24 }, (_, i) => ({
          role: i % 2 ? "assistant" : "user",
          text: `测试对话 ${i + 1}：这里是一段用于验证聊天自动滚动的内容。`,
        })),
      },
    }),
  );
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: async () => {
        const ctx = new AudioContext();
        return ctx.createMediaStreamDestination().stream;
      },
    });
  });
  await page.route("**/api/episodes/*/question", (route) =>
    route.fulfill({
      json: {
        revision: route.request().postDataJSON().revision,
        answer: "我们在讨论散步怎样帮助思考。",
        action: "answer",
        sources: [],
        tools: [],
      },
    }),
  );
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /对话发生过，.*你依然可以加入。/ }),
  ).toBeVisible();
  await page.getByRole("link", { name: /给思考留一点空间/ }).click();
  await expect(
    page.getByRole("heading", { name: "给思考留一点空间" }),
  ).toBeVisible();
  await page.locator("audio").evaluate((a: HTMLAudioElement) => {
    a.currentTime = 0;
  });
  const transcript = page.getByRole("region", { name: "文字稿" });
  await expect(transcript.locator(".transcript-line")).toHaveCount(6);

  await page.locator(".player-header").click();
  await page.keyboard.press("Space");
  await expect
    .poll(() =>
      page.locator("audio").evaluate((a: HTMLAudioElement) => a.currentTime),
    )
    .toBeGreaterThan(0.4);
  await expect(page.locator(".player-card")).toHaveClass(/compact/);
  expect(
    await page
      .locator(".player-card")
      .evaluate((el) => el.getBoundingClientRect().height),
  ).toBeLessThan(105);
  await expect
    .poll(() =>
      page
        .getByRole("log")
        .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
    )
    .toBeLessThan(2);

  await page.locator("audio").evaluate((a: HTMLAudioElement) => {
    a.currentTime = 3;
  });
  await expect(transcript.locator('[aria-current="true"]')).toHaveCount(1);
  await expect(transcript.locator('[aria-current="true"]')).toContainText(
    "今天天气真好",
  );
  await transcript.hover();
  await page.mouse.wheel(0, 180);
  await expect(
    page.getByRole("button", { name: "回到当前播放" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "回到当前播放" }).click();
  await expect(page.getByRole("button", { name: "回到当前播放" })).toHaveCount(
    0,
  );
  await expect
    .poll(() =>
      transcript.evaluate((box) => {
        const current = box.querySelector('[aria-current="true"]')!;
        return (
          current.getBoundingClientRect().top >= box.getBoundingClientRect().top
        );
      }),
    )
    .toBe(true);
  await expect(
    page.getByRole("button", { name: "插一句", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("textbox", { name: "输入消息" }).fill("Why?");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.locator(".return-note")).toContainText("0:00");
  await expect(page.locator(".conversation-origin")).toHaveText(
    /从 \d+:\d{2} 开始聊/,
  );
  // The podcast fades out before pausing.
  await expect
    .poll(() =>
      page.locator("audio").evaluate((a: HTMLAudioElement) => a.paused),
    )
    .toBe(true);
  await page.screenshot({
    path: "test-results/player-interrupted.png",
    fullPage: true,
  });
  await page.waitForTimeout(1200);
  expect(
    await page.locator("audio").evaluate((a: HTMLAudioElement) => a.paused),
  ).toBe(true);
  await page.getByRole("button", { name: "继续听 ↗" }).click();
  await expect(page.locator(".conversation-origin")).toHaveCount(0);
  await expect
    .poll(() =>
      page.locator("audio").evaluate((a: HTMLAudioElement) => a.paused),
    )
    .toBe(false);
  expect(
    await page
      .locator("audio")
      .evaluate((a: HTMLAudioElement) => a.currentTime),
  ).toBeLessThan(2);
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(page.locator(".player-card")).not.toHaveClass(/compact/);
  await expect(page.locator(".cover")).toBeHidden();
  const questionInput = page.getByRole("textbox", { name: "输入消息" });
  await questionInput.fill("hello");
  await questionInput.press("Space");
  await expect(questionInput).toHaveValue("hello ");
  await expect(
    page.getByRole("button", { name: "播放", exact: true }),
  ).toBeVisible();
  await questionInput.fill("");

  expect(
    await page
      .locator(".player-card")
      .evaluate((el) => el.getBoundingClientRect().height),
  ).toBeLessThan(105);
  await page.getByRole("button", { name: "播放", exact: true }).click();
  await expect(page.locator(".player-card")).toHaveClass(/compact/);
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(page.locator(".player-card")).not.toHaveClass(/compact/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "聊两句", exact: true }).click();
  await expect
    .poll(() =>
      page
        .getByRole("log")
        .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
    )
    .toBeLessThan(2);
  await page.screenshot({ path: "test-results/player-mobile.png" });
  // While listening on mobile the transcript and chat become collapsible panels
  // inside a viewport-locked layout.
  await page.getByRole("button", { name: "播放", exact: true }).click();
  await expect(page.locator(".player-card")).toHaveClass(/compact/);
  await expect(page.getByRole("button", { name: "文字稿" })).toBeVisible();
  await expect(page.getByRole("region", { name: "文字稿" })).toBeVisible();
  await expect(page.getByRole("log", { name: "对话记录" })).toBeHidden();
  await page.getByRole("button", { name: "聊两句" }).click();
  await expect(page.getByRole("log", { name: "对话记录" })).toBeVisible();
  await expect(page.getByRole("region", { name: "文字稿" })).toBeHidden();
  const dockBottom = await page
    .locator(".player-dock")
    .evaluate((element) =>
      Math.abs(element.getBoundingClientRect().bottom - innerHeight),
    );
  expect(dockBottom).toBeLessThan(2);
  await page.screenshot({ path: "test-results/player-mobile-listening.png" });
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  expect(errors).toEqual([]);
});

test("automatic listening preconnects; speech during startup uses WAV fallback without pausing", async ({
  page,
}) => {
  let creates = 0,
    transcriptions = 0;
  let wav: Buffer | undefined;
  let release!: () => void;
  const firstQuestion = new Promise<void>((r) => (release = r));
  await page.route("**/api/health", async (route) => {
    const upstream = await route.fetch();
    const health = await upstream.json();
    await route.fulfill({
      json: {
        ...health,
        liveConfigured: true,
        microphone: {
          threshold: 0.025,
          minSpeechMs: 120,
          silenceMs: 160,
          vadEnabled: false,
        },
      },
    });
  });
  await page.route("**/api/episodes/*/live", async (route) => {
    creates++;
    await firstQuestion;
    await route.fulfill({
      status: 503,
      json: { error: "模拟连接失败，未调用付费服务" },
    });
  });
  await page.route("**/api/episodes/*/transcribe-question", async (route) => {
    transcriptions++;
    const body = route.request().postDataBuffer()!;
    const at = body.indexOf(Buffer.from("RIFF"));
    wav = body.subarray(at);
    release();
    await route.fulfill({ json: { text: "为什么散步会带来灵感？" } });
  });
  await page.addInitScript(() => {
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
        Object.assign(window, {
          asideTestMic: { gain, ctx, stream: dest.stream },
        });
        return dest.stream;
      },
    });
  });
  await page.goto("/");
  await page.getByRole("link", { name: /给思考留一点空间/ }).click();
  await page.getByRole("button", { name: "播放", exact: true }).click();
  await expect.poll(() => creates).toBe(1);
  expect(transcriptions).toBe(0);
  await page.evaluate(() => {
    (window as any).asideTestMic.gain.gain.value = 0.15;
  });
  await expect.poll(() => creates).toBe(1);
  expect(
    await page.evaluate(
      () => (window as any).asideTestMic.stream.getTracks()[0].readyState,
    ),
  ).toBe("live");
  expect(
    await page.locator("audio").evaluate((a: HTMLAudioElement) => a.paused),
  ).toBe(false);
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    (window as any).asideTestMic.gain.gain.value = 0;
  });
  await expect.poll(() => transcriptions).toBe(1);
  expect(wav?.subarray(8, 12).toString()).toBe("WAVE");
  expect(wav!.readUInt32LE(40)).toBeGreaterThan(wav!.readUInt32LE(24));
  await expect(
    page.getByRole("status").filter({ hasText: "● 本地监听" }),
  ).toBeVisible();
  expect(creates).toBe(1);
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "麦克风未监听" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as any).asideTestMic.stream.getTracks()[0].readyState,
    ),
  ).toBe("ended");
});

for (const manual of [false]) {
  test(`native WebRTC ${manual ? "manual" : "automatic"} voice answers, waits and resumes safely`, async ({
    page,
  }) => {
    let creates = 0,
      transcriptions = 0;
    const usage: any[] = [];
    let live!: FakeDelegatedLive;
    let emitted = Promise.resolve();
    page.on("close", () => live?.close());
    const emit = (event: LiveControlEvent) => {
      emitted = emitted
        .then(() =>
          page.evaluate(
            (value) =>
              (window as any).asideControlPush?.(JSON.stringify(value) + "\n"),
            event,
          ),
        )
        .catch(() => {});
    };
    await page.route("**/api/health", async (route) => {
      const r = await route.fetch();
      await route.fulfill({
        json: {
          ...(await r.json()),
          liveConfigured: true,
          microphone: {
            threshold: 0.025,
            minSpeechMs: 120,
            silenceMs: 160,
            vadEnabled: false,
          },
          voiceLifecycle: { preRollMs: 750, graceMs: 100, idleCloseMs: 60000 },
        },
      });
    });
    await page.route("**/api/episodes/*/transcribe-question", (route) => {
      transcriptions++;
      return route.fulfill({
        json: {
          text:
            transcriptions === 1 ? "为什么散步会带来灵感？" : "Okay, go on.",
        },
      });
    });
    await page.route("**/api/episodes/*/question", async (route) => {
      await route.fulfill({
        status: 500,
        json: {
          error: "Voice decisions must arrive through the server stream",
        },
      });
    });
    await page.route("**/api/episodes/*/live-control", (route) => {
      const update = route.request().postDataJSON();
      live.update(update.player, update.acknowledgement);
      return route.fulfill({ json: { ok: true } });
    });
    await page.route("**/api/episodes/*/usage", async (route) => {
      usage.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true } });
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
              (window as any).asideControlPush = (line: string) =>
                controller.enqueue(encoder.encode(line));
              controller.enqueue(
                encoder.encode(
                  '{"type":"ready","sessionId":"loopback-test-session"}\n',
                ),
              );
              init?.signal?.addEventListener(
                "abort",
                () => {
                  (window as any).asideControlPush = undefined;
                  controller.close();
                },
                { once: true },
              );
            },
            cancel() {
              (window as any).asideControlPush = undefined;
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
          Object.assign(window, {
            asideTestMic: { gain, ctx, stream: dest.stream },
          });
          return dest.stream;
        },
      });
    });
    await page.route("**/api/episodes/*/live", async (route) => {
      creates++;
      const { sdp, control } = route.request().postDataJSON();
      expect(control).toBeTruthy();
      const episode = await (
        await page.request.get("/api/episodes/demo-natural-resume")
      ).json();
      // Only the backend model behind GPT-Live's delegation is substituted.
      live = new FakeDelegatedLive(
        control.player,
        episode.analysis,
        emit,
        (text) =>
          text === "Okay, go on."
            ? { resume: true }
            : { answer: "散步给思考留下一点空间。", lookup: true },
      );
      const answer = await page.evaluate(async (offer) => {
        const peer = new RTCPeerConnection();
        Object.assign(window, { asideLoopback: peer, asideCloudEvents: [] });
        peer.ondatachannel = (e) => {
          const channel = e.channel;
          Object.assign(window, { asideCloudChannel: channel });
          channel.onopen = () =>
            channel.send(JSON.stringify({ type: "session.started" }));
          channel.onmessage = (message) => {
            const event = JSON.parse(message.data);
            (window as any).asideCloudEvents.push(event);
            if (event.type === "session.commentary.append")
              channel.send(
                JSON.stringify({
                  type: "session.output_transcript.delta",
                  delta: event.content,
                }),
              );
            if (event.type === "session.close")
              channel.send(
                JSON.stringify({
                  type: "session.closed",
                  usage: { seconds: 4 },
                }),
              );
          };
        };
        await peer.setRemoteDescription({ type: "offer", sdp: offer });
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const destination = context.createMediaStreamDestination();
        gain.gain.value = 0;
        oscillator.connect(gain).connect(destination);
        oscillator.start();
        await context.resume();
        peer.addTrack(
          destination.stream.getAudioTracks()[0],
          destination.stream,
        );
        Object.assign(window, {
          asideAnswerGain: gain,
          asideAnswerContext: context,
        });
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
          session: { id: "loopback-test-session" },
          transport: { sdp: answer },
          control: true,
        },
      });
    });
    await page.goto("/");
    await page.getByRole("link", { name: /给思考留一点空间/ }).click();
    await page.getByRole("button", { name: "播放", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "● 语音交流中" }),
    ).toBeVisible();
    expect(creates).toBe(1);
    if (manual) {
      await page.getByRole("button", { name: "按住说话", exact: true }).focus();
      await page.keyboard.down("Space");
    } else {
      await page.evaluate(() => {
        (window as any).asideTestMic.gain.gain.value = 0.15;
      });
    }
    await expect.poll(() => creates).toBe(1);
    await page.waitForTimeout(250);
    if (!manual)
      await page.evaluate(() => {
        const channel = (window as any).asideCloudChannel;
        channel.send(
          JSON.stringify({
            type: "session.input_transcript.delta",
            delta: "为什么散步会带来灵感？",
          }),
        );
        channel.send(
          JSON.stringify({
            type: "session.delegation.created",
            delegation: { target: "client", id: "question-1" },
          }),
        );
      });
    live.receive({
      type: "session.input_transcript.delta",
      delta: "为什么散步会带来灵感？",
      start_ms: 0,
      end_ms: 500,
    });
    await live.delegate("为什么散步会带来灵感？");
    await emitted;
    await page.waitForTimeout(300);
    // The voice model speaks the backend's answer itself: its transcript
    // arrives over the data channel once the reply window is open.
    await page.evaluate(() =>
      (window as any).asideCloudChannel.send(
        JSON.stringify({
          type: "session.output_transcript.delta",
          delta: "散步给思考留下一点空间。",
        }),
      ),
    );
    if (manual) await page.keyboard.up("Space");
    else
      await page.evaluate(() => {
        (window as any).asideTestMic.gain.gain.value = 0;
      });
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: manual ? "可继续追问" : "● 语音交流中" }),
    ).toBeVisible({
      timeout: 15000,
    });
    await expect.poll(() => live.utterances.length).toBe(1);
    expect(live.utterances.at(-1)).toBe("为什么散步会带来灵感？");
    // Emit real loopback audio: captions are paced against audible output,
    // and the countdown starts after that output ends.
    await page.waitForTimeout(1100);
    await page.evaluate(() => {
      (window as any).asideAnswerGain.gain.value = 0.15;
    });
    await expect(page.locator(".status")).toContainText("正在回答");
    await expect(page.locator(".message.assistant").last()).toContainText(
      "散步给思考留下一点空间。",
    );
    // Aside's audible answer takes over the dock waveform and marks its avatar.
    await expect(page.locator(".timeline-wave")).toHaveClass(/is-agent/);
    await expect(page.locator(".message.assistant.is-speaking")).toHaveCount(1);
    await expect
      .poll(() =>
        page
          .locator(".timeline-wave i")
          .evaluateAll((bars) =>
            Math.max(
              ...bars.map((bar) =>
                Number(
                  /scaleY\(([\d.]+)\)/.exec(
                    (bar as HTMLElement).style.transform,
                  )?.[1] ?? 0,
                ),
              ),
            ),
          ),
      )
      .toBeGreaterThan(0.8);
    await page
      .locator(".player-dock")
      .screenshot({ path: "test-results/dock-agent-answering.png" });
    await expect(page.locator(".followup-window")).not.toContainText(
      "秒后继续播放",
    );
    await page.evaluate(() => {
      (window as any).asideAnswerGain.gain.value = 0;
    });
    // Main now starts a quiet window after the backend's final answer.
    // The listener can still hold that window until an explicit continuation.
    await expect(page.locator(".followup-window")).toContainText(
      "秒后继续播放",
    );
    await page.getByRole("button", { name: "先别继续" }).click();
    await expect(page.locator(".followup-window")).toContainText(
      "准备好了，再继续听",
    );
    await expect(page.getByRole("button", { name: "先别继续" })).toHaveCount(0);
    await page.waitForTimeout(3200);
    expect(
      await page.locator("audio").evaluate((a: HTMLAudioElement) => a.paused),
    ).toBe(true);
    // A warm-session spoken command is delegated without standalone transcription.
    if (manual) {
      await page.getByRole("button", { name: "按住说话", exact: true }).focus();
      await page.keyboard.down("Space");
      await expect(
        page.getByRole("button", { name: "按住说话", exact: true }),
      ).toContainText("正在录音");
      await page.keyboard.up("Space");
    } else {
      await page.evaluate(() => {
        (window as any).asideTestMic.gain.gain.value = 0.15;
      });
      await page.waitForTimeout(250);
      await page.evaluate(() => {
        (window as any).asideTestMic.gain.gain.value = 0;
        (window as any).asideCloudChannel.send(
          JSON.stringify({
            type: "session.input_transcript.delta",
            delta: "Okay, go on.",
          }),
        );
        (window as any).asideCloudChannel.send(
          JSON.stringify({
            type: "session.delegation.created",
            delegation: { target: "client", id: "resume-1" },
          }),
        );
      });
      live.receive({
        type: "session.input_transcript.delta",
        delta: "Okay, go on.",
        start_ms: 3000,
        end_ms: 3500,
      });
      await live.delegate("Okay, go on.");
    }
    // A server-owned resume returns to the anchor at once.
    await expect
      .poll(() =>
        page.locator("audio").evaluate((a: HTMLAudioElement) => a.paused),
      )
      .toBe(false);
    await page.evaluate(() => {
      (window as any).asideCloudChannel.send(
        JSON.stringify({
          type: "session.output_transcript.delta",
          delta: "过期回答不得回流",
        }),
      );
      (window as any).asideCloudChannel.send(
        JSON.stringify({
          type: "session.delegation.created",
          delegation: { target: "client", id: "stale-delegation" },
        }),
      );
    });
    await expect(page.getByRole("log")).not.toContainText("过期回答不得回流");
    // Losing the cloud during an already requested continuation must not cancel playback.
    await page.evaluate(() => {
      (window as any).asideCloudChannel.send(
        JSON.stringify({
          type: "error",
          error: { message: "模拟续播期间断线" },
        }),
      );
      (window as any).asideCloudChannel.send(
        JSON.stringify({ type: "session.closed", usage: { seconds: 4 } }),
      );
    });
    await page.waitForTimeout(900);
    expect(
      await page.locator("audio").evaluate((a: HTMLAudioElement) => a.paused),
    ).toBe(false);

    await expect(
      page
        .getByRole("status")
        .filter({ hasText: manual ? "麦克风未监听" : "● 本地监听" }),
    ).toBeVisible();
    await expect.poll(() => usage.length).toBe(1);
    expect(live.utterances).toHaveLength(2);
    expect(transcriptions).toBe(0);
    expect(usage[0]).toMatchObject({
      sessionId: "loopback-test-session",
      finalized: true,
      seconds: 4,
    });
    await expect
      .poll(() =>
        page.locator("audio").evaluate((a: HTMLAudioElement) => a.paused),
      )
      .toBe(false);
    await expect(page.locator(".timeline-wave")).not.toHaveClass(/is-agent/);
    expect(
      await page.evaluate(
        () => (window as any).asideTestMic.stream.getTracks()[0].readyState,
      ),
    ).toBe(manual ? "ended" : "live");
    expect(creates).toBe(1);
    await page.getByRole("button", { name: "暂停", exact: true }).click();
    await page.evaluate(() => {
      (window as any).asideLoopback.close();
      (window as any).asideTestMic.ctx.close();
      (window as any).asideAnswerContext.close();
    });
  });
}
