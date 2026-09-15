import { test, expect, type Page } from "@playwright/test";
import type { Episode } from "@aside/engine/core";
import { createPlayerConfig } from "@aside/engine/player";

test.use({ locale: "en-US" });

// A local silent WAV exercises the real media element without model or backend calls.
const wav = Buffer.alloc(44 + 8000 * 2 * 60);
wav.write("RIFF", 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(wav.length - 44, 40);
const episodes: Episode[] = ["a", "b"].map((id) => ({
  id: `remote-${id}`,
  title: `Remote sample ${id}`,
  durationMs: 60000,
  createdAt: "2026-09-14",
  status: "ready",
  stage: "ready",
  progress: 1,
  analysis: {
    version: "1",
    source: "demo",
    summary: "Remote control sample",
    hostStyle: "",
    speakers: [],
    voice: "feminine",
    voiceReason: "test",
    passages: [
      {
        id: "first",
        startMs: 0,
        endMs: 20000,
        text: "First passage",
        speaker: "host",
      },
      {
        id: "second",
        startMs: 20000,
        endMs: 40000,
        text: "Second passage",
        speaker: "host",
      },
    ],
    anchors: [
      {
        id: "first",
        startMs: 0,
        endMs: 20000,
        text: "First passage",
        confidence: 1,
      },
      {
        id: "second",
        startMs: 20000,
        endMs: 40000,
        text: "Second passage",
        confidence: 1,
      },
    ],
  },
}));

async function mockPlayer(page: Page) {
  const checkpoints = new Map<string, Record<string, unknown>>();
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health")
      return route.fulfill({
        json: {
          liveConfigured: false,
          uploadsEnabled: false,
          microphone: { threshold: 0.025, minSpeechMs: 120, silenceMs: 650 },
          voiceLifecycle: { preRollMs: 750, graceMs: 5000, idleCloseMs: 60000 },
        },
      });
    if (path === "/api/auth/session")
      return route.fulfill({ json: { user: null } });
    if (path === "/api/episodes") return route.fulfill({ json: episodes });
    if (path.endsWith("/checkpoint")) {
      if (route.request().method() === "PUT") {
        const value = route.request().postDataJSON();
        const current = checkpoints.get(path);
        if (value.version !== (current?.version ?? 0))
          return route.fulfill({ status: 409, json: { error: "Conflict" } });
        checkpoints.set(path, { ...value, version: value.version + 1 });
      }
      return route.fulfill({ json: checkpoints.get(path) ?? null });
    }
    if (path.endsWith("/audio")) {
      const range = /bytes=(\d+)-(\d*)/.exec(
        route.request().headers().range ?? "",
      );
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2]
        ? Math.min(Number(range[2]), wav.length - 1)
        : wav.length - 1;
      return route.fulfill({
        status: range ? 206 : 200,
        contentType: "audio/wav",
        headers: {
          "Accept-Ranges": "bytes",
          ...(range
            ? { "Content-Range": `bytes ${start}-${end}/${wav.length}` }
            : {}),
        },
        body: wav.subarray(start, end + 1),
      });
    }
    const episode = episodes.find((e) => path === `/api/episodes/${e.id}`);
    if (episode) return route.fulfill({ json: episode });
    // Block all unanticipated endpoints, including paid ones.
    return route.fulfill({
      status: 404,
      json: { error: "Not available in player test" },
    });
  });
}

test("speed selection persists across media changes and page reloads", async ({
  page,
}) => {
  await mockPlayer(page);
  await page.goto("/?episode=remote-a");
  const speed = page.getByRole("button", { name: "Playback speed" });
  await expect(speed).toContainText("1×");
  await speed.click();
  await page.getByRole("option", { name: /0.75×/ }).click();
  await expect
    .poll(() =>
      page.locator("audio").evaluate((a: HTMLAudioElement) => a.playbackRate),
    )
    .toBe(0.75);
  await page.getByRole("button", { name: /Remote sample b/ }).click();
  await expect(
    page.getByRole("heading", { name: "Remote sample b" }),
  ).toBeVisible();
  await expect(speed).toContainText("0.75×");
  await expect
    .poll(() =>
      page.locator("audio").evaluate((a: HTMLAudioElement) => a.playbackRate),
    )
    .toBe(0.75);
  await page.goto("/?episode=remote-b");
  await expect(speed).toContainText("0.75×");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect
    .poll(() =>
      page.locator("audio").evaluate((a: HTMLAudioElement) => a.paused),
    )
    .toBe(false);
  await expect
    .poll(() =>
      page.locator("audio").evaluate((a: HTMLAudioElement) => a.currentTime),
    )
    .toBeGreaterThan(0);
  expect(
    await page.locator("audio").evaluate((a: HTMLAudioElement) => ({
      rate: a.playbackRate,
      pitch: a.preservesPitch,
    })),
  ).toEqual({ rate: 0.75, pitch: true });
});

test("configured arbitrary speed, volume and mute reach the actual media element", async ({
  page,
}) => {
  await mockPlayer(page);
  await page.addInitScript(
    (config) =>
      localStorage.setItem("aside.playerConfig.v1", JSON.stringify(config)),
    createPlayerConfig({
      playbackRate: 0.9,
      volume: 0.4,
      muted: true,
      preservesPitch: false,
    }),
  );
  await page.goto("/?episode=remote-a");
  await expect(
    page.getByRole("button", { name: "Playback speed" }),
  ).toContainText("0.9×");
  await expect
    .poll(() =>
      page.locator("audio").evaluate((a: HTMLAudioElement) => ({
        rate: a.playbackRate,
        volume: a.volume,
        muted: a.muted,
        pitch: a.preservesPitch,
      })),
    )
    .toEqual({ rate: 0.9, volume: 0.4, muted: true, pitch: false });
});

test("volume slider and mute button control the audio and survive reload", async ({
  page,
}) => {
  await mockPlayer(page);
  await page.goto("/?episode=remote-a");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  // The silent fixture should drive live analyser bars down to their minimum,
  // while volume controls continue to work on the routed media element.
  await expect
    .poll(() =>
      page
        .locator(".timeline-wave i")
        .first()
        .evaluate((bar) => bar.style.transform),
    )
    .toBe("scaleY(0.28)");
  const volume = page.getByRole("slider", { name: "Podcast volume" });
  await volume.focus();
  await page.keyboard.press("Home");
  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowRight");
  await expect
    .poll(() =>
      page.locator("audio").evaluate((a: HTMLAudioElement) => a.volume),
    )
    .toBe(0.4);
  const mute = page.getByRole("button", { name: "Mute", exact: true });
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() =>
      page.locator("audio").evaluate((a: HTMLAudioElement) => a.muted),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.locator("audio").evaluate((a: HTMLAudioElement) => a.paused),
    )
    .toBe(false);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator(".timeline-wave i")
        .first()
        .evaluate((bar) => bar.style.transform),
    )
    .toBe("");
  await page.goto("/?episode=remote-a");
  await expect(volume).toHaveValue("40");
  await expect(mute).toHaveAttribute("aria-pressed", "true");
  await mute.click();
  await expect
    .poll(() =>
      page.locator("audio").evaluate((a: HTMLAudioElement) => ({
        volume: a.volume,
        muted: a.muted,
      })),
    )
    .toEqual({ volume: 0.4, muted: false });
  await volume.focus();
  await page.keyboard.press("ArrowRight");
  await expect(volume).toHaveValue("41");
});

test("transcript navigation still starts playback at the selected passage", async ({
  page,
}) => {
  await mockPlayer(page);
  await page.goto("/?episode=remote-a");
  const audio = page.locator("audio");
  await expect
    .poll(() => audio.evaluate((a: HTMLAudioElement) => a.readyState))
    .toBeGreaterThan(0);
  for (const [text, time, label] of [
    ["Second passage", 20, "0:20"],
    ["First passage", 0, "0:00"],
  ] as const) {
    await page.locator(".transcript-line").filter({ hasText: text }).click();
    await page
      .getByRole("button", {
        name: `Play from this sentence ${label}`,
        exact: true,
      })
      .click();
    await expect
      .poll(() => audio.evaluate((a: HTMLAudioElement) => a.paused))
      .toBe(false);
    const at = await audio.evaluate((a: HTMLAudioElement) => a.currentTime);
    expect(at).toBeGreaterThanOrEqual(time);
    expect(at).toBeLessThan(time + 3);
  }
});

for (const width of [1440, 768, 375, 320]) {
  test(`remote controls fit and remain accessible at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await mockPlayer(page);
    await page.goto("/?episode=remote-a");
    const dock = page.locator(".player-dock");
    for (const name of ["Mute"]) {
      const button = dock.getByRole("button", { name, exact: true });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect(box!.height).toBeGreaterThanOrEqual(36);
    }
    await expect(
      dock.getByRole("slider", { name: "Podcast volume" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`remote-${width}.png`),
      fullPage: true,
    });
  });
}
