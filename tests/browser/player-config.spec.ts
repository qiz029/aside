import { test, expect } from "@playwright/test";
import { createPlayerConfig } from "@aside/engine/player";
import { mockPlayer } from "./remote-fixture";

test.use({ locale: "en-US" });

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
        .evaluate((bar) => bar.style.getPropertyValue("--wave-level")),
    )
    .toBe("0.280");
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
        .evaluate((bar) => bar.style.getPropertyValue("--wave-level")),
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
