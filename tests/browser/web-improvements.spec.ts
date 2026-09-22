import { test, expect } from "@playwright/test";
import { mockPlayer, episodes } from "./remote-fixture";

test.use({ locale: "en-US", launchOptions: { args: ["--mute-audio"] } });
async function streamingPlayer(page: import("@playwright/test").Page) {
  await mockPlayer(page);
  await page.route("**/api/health", (route) =>
    route.fulfill({
      json: {
        liveConfigured: true,
        uploadsEnabled: false,
        microphone: { threshold: 0.025, minSpeechMs: 120, silenceMs: 650 },
        voiceLifecycle: { preRollMs: 750, graceMs: 5000, idleCloseMs: 60000 },
      },
    }),
  );
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      if (!String(input).endsWith("/question")) return original(input, init);
      (window as any).streamHeader = new Headers(init?.headers).get(
        "X-Aside-Answer-Stream",
      );
      const { revision } = JSON.parse(String(init?.body));
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            const send = (event: unknown) =>
              controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
            send({ type: "answer", revision, text: "The answer starts here" });
            (window as any).finishAnswer = () => {
              send({
                type: "result",
                result: {
                  revision,
                  answer: "The answer starts here and is now complete.",
                  action: "answer",
                  sources: [],
                  tools: [],
                },
              });
              controller.close();
            };
          },
        }),
        { headers: { "Content-Type": "application/x-ndjson" } },
      );
    };
  });
  await page.goto("/?episode=remote-a");
  await page
    .getByRole("textbox", { name: "Your message" })
    .fill("Explain this passage");
  await page.getByRole("button", { name: "Send message" }).click();
}
test("text answer appears before completion and is committed exactly once", async ({
  page,
}) => {
  await streamingPlayer(page);
  await expect(page.locator(".message.is-preview")).toHaveText(
    /The answer starts here/,
  );
  expect(await page.evaluate(() => (window as any).streamHeader)).toBe("1");
  await expect(page.locator(".message.assistant:not(.is-preview)")).toHaveCount(
    0,
  );
  await page.evaluate(() => (window as any).finishAnswer());
  await expect(page.locator(".message.is-preview")).toHaveCount(0);
  await expect(page.locator(".message.assistant")).toHaveCount(1);
  await expect(page.locator(".message.assistant")).toContainText(
    "and is now complete.",
  );
});
test("new conversation discards an unfinished streamed answer", async ({
  page,
}) => {
  await streamingPlayer(page);
  await expect(page.locator(".message.is-preview")).toBeVisible();
  await page
    .getByRole("button", { name: "New conversation", exact: true })
    .click();
  await expect(page.locator(".message")).toHaveCount(0);
  await page.evaluate(() => (window as any).finishAnswer());
  await expect(page.locator(".message")).toHaveCount(0);
});
test("audio ticks update progress without saving every tick or polling a ready library", async ({
  page,
}) => {
  await mockPlayer(page);
  let writes = 0,
    lists = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/checkpoint") && request.method() === "PUT")
      writes++;
    if (request.url().endsWith("/api/episodes")) lists++;
  });
  await page.goto("/?episode=remote-a");
  await expect(page.locator(".timeline")).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator("audio")
        .evaluate((audio: HTMLAudioElement) => audio.readyState),
    )
    .toBeGreaterThan(0);
  // Settle initial checkpoint hydration before measuring playback ticks.
  await page.waitForTimeout(300);
  const before = { writes, lists };
  for (const position of [3, 5, 8, 12, 24]) {
    await page.locator("audio").evaluate((audio: HTMLAudioElement, at) => {
      audio.currentTime = at;
      audio.dispatchEvent(new Event("timeupdate"));
    }, position);
    await expect(page.locator(".timeline")).toHaveValue(
      String(position * 1000),
    );
  }
  await expect(page.locator(".transcript-line.is-current")).toContainText(
    "Second passage",
  );
  await page.waitForTimeout(5500);
  expect(writes - before.writes).toBe(0);
  expect(lists - before.lists).toBe(0);
  await page.waitForTimeout(10000);
  expect(writes - before.writes).toBe(1);
});
for (const width of [1440, 390])
  test(`long transcript renders a bounded window and follows distant playback at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await mockPlayer(page);
    const episode = structuredClone(episodes[0]);
    episode.analysis!.passages = Array.from({ length: 2000 }, (_, i) => ({
      id: `p-${i}`,
      startMs: i * 30,
      endMs: (i + 1) * 30,
      speaker: "host",
      text:
        `Passage ${i}. ` +
        "A longer passage with variable line wrapping. ".repeat((i % 5) + 1),
    }));
    await page.route("**/api/episodes/remote-a", (route) =>
      route.fulfill({ json: episode }),
    );
    await page.goto("/?episode=remote-a");
    await expect(page.locator(".transcript-line.is-current")).toContainText(
      "Passage 0.",
    );
    expect(await page.locator(".transcript-line").count()).toBeLessThan(60);
    await page.locator("audio").evaluate((audio: HTMLAudioElement) => {
      audio.currentTime = 45;
      audio.dispatchEvent(new Event("timeupdate"));
    });
    await expect(page.locator(".transcript-line.is-current")).toContainText(
      "Passage 1500.",
    );
    await expect(page.locator(".transcript-line.is-current")).toBeInViewport();
    await page.screenshot({
      path: `test-results/web-long-transcript-${width}.png`,
    });
    await page.locator(".transcript-lyrics").hover();
    await page.mouse.wheel(0, -500);
    await expect(
      page.getByRole("button", { name: "Back to current position" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Back to current position" })
      .click();
    await expect(page.locator(".transcript-line.is-current")).toBeInViewport();
    expect(await page.locator(".transcript-line").count()).toBeLessThan(60);
  });
