import { test, expect } from "@playwright/test";
import type { Checkpoint } from "@aside/engine/contracts";
import { mockPlayer } from "./remote-fixture";

test.use({ locale: "en-US", launchOptions: { args: ["--mute-audio"] } });

for (const width of [1440, 320]) {
  test(`new conversation clears persisted history and preserves playback at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockPlayer(page);
    let checkpoint: Checkpoint = {
      version: 1,
      positionMs: 31000,
      history: Array.from({ length: 60 }, (_, i) => ({
        role: i % 2 ? "assistant" : "user",
        text: `Previous turn ${i}`,
      })),
    };
    const requests: any[] = [];
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      Object.assign(window, { microphoneRequests: 0 });
      navigator.mediaDevices.getUserMedia = async () => {
        (window as any).microphoneRequests++;
        throw Error("Microphone must remain off in this test");
      };
    });
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
    await page.route("**/api/episodes/remote-a/checkpoint", async (route) => {
      if (route.request().method() === "PUT") {
        checkpoint = {
          ...route.request().postDataJSON(),
          version: (checkpoint.version ?? 0) + 1,
        };
      }
      return route.fulfill({ json: checkpoint });
    });
    await page.route("**/api/episodes/remote-a/question", (route) => {
      const body = route.request().postDataJSON();
      requests.push(body);
      // Simulate an already-open tab receiving the old deployment's error.
      if (requests.length === 1)
        return route.fulfill({
          status: 413,
          json: {
            error: "问题或对话过长，请开始新的对话",
          },
        });
      return route.fulfill({
        contentType: "application/x-ndjson",
        body:
          JSON.stringify({
            type: "result",
            result: {
              revision: body.revision,
              answer: "A fresh answer",
              action: "answer",
              sources: [],
              tools: [],
            },
          }) + "\n",
      });
    });
    await page.goto("/?episode=remote-a");
    if (width < 600)
      await page.locator(".conversation .mobile-panel-toggle").click();
    const chat = page.locator(".conversation");
    const reset = chat.getByRole("button", {
      name: "New conversation",
      exact: true,
    });
    await expect(reset).toBeVisible();
    await expect(chat.getByRole("log")).toContainText("Previous turn 59");
    await expect
      .poll(() =>
        page
          .locator("audio")
          .evaluate((audio: HTMLAudioElement) => audio.currentTime),
      )
      .toBe(31);
    await page
      .getByRole("textbox", { name: "Your message" })
      .fill("One more question");
    await page.getByRole("button", { name: "Send message" }).click();
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("conversation");
    const recovery = alert.getByRole("button", {
      name: "New conversation",
      exact: true,
    });
    await expect(recovery).toBeVisible();
    await page.screenshot({
      path: `test-results/new-conversation-error-${width}.png`,
      fullPage: true,
    });
    await recovery.click();
    await expect(alert).toHaveCount(0);
    await expect(chat.getByRole("log")).not.toContainText("Previous turn");
    await expect.poll(() => checkpoint.history.length).toBe(0);
    expect(checkpoint.positionMs).toBe(31000);
    expect(
      await page
        .locator("audio")
        .evaluate((audio: HTMLAudioElement) => audio.paused),
    ).toBe(true);
    expect(await page.evaluate(() => (window as any).microphoneRequests)).toBe(
      0,
    );
    await page.screenshot({
      path: `test-results/new-conversation-empty-${width}.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.reload();
    if (width < 600)
      await page.locator(".conversation .mobile-panel-toggle").click();
    await expect(reset).toBeVisible();
    await expect(chat.getByRole("log")).not.toContainText("Previous turn");
    await page
      .getByRole("textbox", { name: "Your message" })
      .fill("A fresh question");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(chat.getByRole("log")).toContainText("A fresh answer");
    expect(requests.at(-1).history.map((turn: any) => turn.text)).toEqual([
      "A fresh question",
    ]);
    expect(await page.evaluate(() => (window as any).microphoneRequests)).toBe(
      0,
    );
    expect(errors).toEqual([]);
  });
}
