/** Run against the localhost mobile fixture and the Vite UI. No external model requests. */
import { chromium, request, expect } from "@playwright/test";
const apiOrigin = "http://127.0.0.1:4311";
const api = await request.newContext({
  baseURL: apiOrigin,
  extraHTTPHeaders: { Origin: apiOrigin },
});
const email = process.env.EMAIL ?? "android-voice-final@example.com";
let browser;
try {
  const sent = await api.post("/api/auth/mobile/email/start", {
    data: { email },
  });
  expect(sent.status()).toBe(200);
  const verified = await api.post("/api/auth/email/verify", {
    data: { email, code: "12345678" },
  });
  expect(verified.status()).toBe(200);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    storageState: await api.storageState(),
    locale: "en-US",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  // Vite and the fixture have separate local ports. Production serves both on one origin.
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({
      url: apiOrigin + url.pathname + url.search,
      headers: { ...route.request().headers(), origin: apiOrigin },
    });
    await route.fulfill({ response });
  });
  await page.goto("http://127.0.0.1:5173/?episode=mobile-sample");
  await expect(page.getByText("A short answer", { exact: true })).toBeVisible();
  const checkpoint = "/api/episodes/mobile-sample/checkpoint";
  async function read() {
    const r = await api.get(checkpoint);
    expect(r.status()).toBe(200);
    return r.json();
  }
  async function remote(positionMs) {
    const current = await read();
    const r = await api.put(checkpoint, {
      data: { ...current, positionMs, resumeMs: undefined },
    });
    expect(r.status()).toBe(200);
  }
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "Another device updated your progress" });
  await remote(90000);
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(alert).toBeVisible();
  await page
    .getByRole("button", { name: "Use other device", exact: true })
    .click();
  await expect
    .poll(() => page.locator("audio").evaluate((a) => a.currentTime))
    .toBeCloseTo(90, 0);
  await remote(120000);
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(alert).toBeVisible();
  await page
    .getByRole("button", { name: "Keep this device", exact: true })
    .click();
  await expect
    .poll(async () => (await read()).positionMs)
    .toBeCloseTo(90000, 0);
  await expect(alert).toHaveCount(0);
  await page.screenshot({ path: "/tmp/aside-web-sync.png" });
  console.log(
    "PASS: Android history restored in web; both checkpoint conflict choices verified against real Worker CAS.",
  );
} finally {
  await browser?.close();
  await api.dispose();
}
