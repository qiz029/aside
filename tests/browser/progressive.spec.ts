import { test, expect } from "@playwright/test";
import { mockPlayer, episodes } from "./remote-fixture";
test.use({ locale: "en-US" });
test("can play and ask before analysis, then receive transcript updates without losing the conversation", async ({
  page,
}) => {
  await mockPlayer(page);
  let complete = false;
  await page.route("**/api/health", (route) =>
    route.fulfill({
      json: {
        liveConfigured: true,
        uploadsEnabled: false,
        microphone: { threshold: 0.025, minSpeechMs: 120, silenceMs: 160 },
        voiceLifecycle: { preRollMs: 750, graceMs: 100, idleCloseMs: 60000 },
      },
    }),
  );
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: async () => {
        throw new DOMException(
          "Test has no microphone permission",
          "NotAllowedError",
        );
      },
    });
  });
  await page.route("**/api/episodes/remote-a", (route) =>
    route.fulfill({
      json: {
        ...episodes[0],
        status: complete ? "ready" : "analyzing",
        analysis: complete ? episodes[0].analysis : undefined,
      },
    }),
  );
  await page.route("**/api/episodes/remote-a/question", (route) =>
    route.fulfill({
      json: {
        revision: route.request().postDataJSON().revision,
        action: "answer",
        answer: "You can ask while the transcript is being prepared.",
        sources: [],
        tools: [],
      },
    }),
  );
  await page.goto("/?episode=remote-a");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect
    .poll(() =>
      page.locator("audio").evaluate((a: HTMLAudioElement) => a.paused),
    )
    .toBe(false);
  const input = page.locator(".composer input");
  await expect(input).toBeEnabled();
  await input.fill("Can I ask now?");
  await input.press("Enter");
  await expect(page.getByRole("log")).toContainText("You can ask while");
  complete = true;
  await expect(page.locator(".transcript")).toContainText("First passage", {
    timeout: 10000,
  });
  await expect(page.getByRole("log")).toContainText("Can I ask now?");
});
