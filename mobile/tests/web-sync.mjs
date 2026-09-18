/** Run against the localhost mobile fixture and the Vite UI. No external model requests. */
import { chromium, request, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
const apiOrigin = `http://127.0.0.1:${Number(process.env.PORT ?? 4311)}`;
const webOrigin = process.env.WEB_ORIGIN ?? "http://127.0.0.1:5173";
if (!["localhost", "127.0.0.1"].includes(new URL(webOrigin).hostname))
  throw Error("Use the local Vite fixture only");
const api = await request.newContext({
  baseURL: apiOrigin,
  extraHTTPHeaders: { Origin: apiOrigin },
});
const email = process.env.EMAIL ?? "android-voice-final@example.com";
if (!email.endsWith("@example.com")) throw Error("Use a fixture account");
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
  const checkpoint = "/api/episodes/mobile-sample/checkpoint";
  const initialResponse = await api.get(checkpoint);
  expect(initialResponse.status()).toBe(200);
  const initial = await initialResponse.json();
  expect(initial.history.some((turn) => turn.role === "assistant")).toBe(true);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    storageState: await api.storageState(),
    locale: "en-US",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const questionOrVoiceRequests = [];
  // Vite and the fixture have separate local ports. Production serves both on one origin.
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (
      route.request().method() === "POST" &&
      /\/(question|transcribe|live)$/.test(url.pathname)
    )
      questionOrVoiceRequests.push(url.pathname);
    const response = await route.fetch({
      url: apiOrigin + url.pathname + url.search,
      headers: { ...route.request().headers(), origin: apiOrigin },
    });
    await route.fulfill({ response });
  });
  await page.goto(`${webOrigin}/?episode=mobile-sample`);
  await expect(page.locator(".messages .message-content p")).toHaveText(
    initial.history.map((turn) => turn.text),
  );
  await expect
    .poll(() => page.locator("audio").evaluate((a) => a.currentTime))
    .toBeCloseTo((initial.resumeMs ?? initial.positionMs) / 1000, 0);
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
  const final = await read();
  expect(final.history).toEqual(initial.history);
  expect(questionOrVoiceRequests).toEqual([]);
  await page.screenshot({ path: "/tmp/aside-web-sync.png" });
  await writeFile(
    process.env.EVIDENCE ?? "/tmp/aside-web-sync.json",
    JSON.stringify(
      {
        messageCount: initial.history.length,
        allMessageTextsRestored: true,
        initialAnchorMs: initial.resumeMs ?? initial.positionMs,
        bothConflictChoicesPassed: true,
        finalPositionMs: final.positionMs,
        historyUnchanged: true,
        questionOrVoiceRequests: questionOrVoiceRequests.length,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: Android history restored in web; both checkpoint conflict choices verified against real Worker CAS.",
  );
} finally {
  await browser?.close();
  await api.dispose();
}
