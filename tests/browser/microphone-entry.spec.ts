import { test, expect } from "@playwright/test";

test("entry stays listen-only until the user enables the microphone", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.assign(window, { permissionRequests: 0, permissionTrack: null });
    navigator.mediaDevices.getUserMedia = async () => {
      (window as any).permissionRequests++;
      const context = new AudioContext();
      const stream = context.createMediaStreamDestination().stream;
      (window as any).permissionTrack = stream.getTracks()[0];
      return stream;
    };
    localStorage.setItem("aside.listeningMode", "manual");
    localStorage.setItem("aside.followupMs", "0");
  });
  // Exercise permission ordering without requiring a real provider key.
  await page.route("**/api/health", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...(await response.json()), liveConfigured: true } });
  });
  let paid = 0;
  await page.route(
    /\/api\/episodes\/[^/]+\/(live|question|transcribe-question)$/,
    (route) => {
      paid++;
      return route.fulfill({
        status: 503,
        json: { error: "No provider calls in entry test" },
      });
    },
  );
  await page.goto("/");
  expect(await page.evaluate(() => (window as any).permissionRequests)).toBe(0);
  await page.getByRole("button", { name: "体验示例" }).click();
  await expect(page.getByRole("region", { name: "文字稿" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).permissionRequests)).toBe(0);
  await page.getByRole("button", { name: "开启麦克风", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).permissionRequests))
    .toBe(1);
  await expect
    .poll(() => page.evaluate(() => (window as any).permissionTrack.readyState))
    .toBe("ended");
  await expect(page.getByLabel("插话方式")).toHaveCount(0);
  await expect(page.getByLabel("回答后继续")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "按住说话", exact: true }),
  ).toHaveCount(0);
  expect(
    await page
      .locator("audio")
      .evaluate((audio: HTMLAudioElement) => audio.paused),
  ).toBe(true);
  expect(paid).toBe(0);
});
