import { test, expect } from "@playwright/test";
test.use({ locale: "en-US" });
test("English samples show attribution, timed transcripts, and playable audio", async ({
  page,
}) => {
  // Six published recordings plus each cabinet opening/return transition.
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("denied", "NotAllowedError");
    };
  });
  // The local synthetic regression fixture is not a published recording.
  await page.route("**/api/episodes", async (route) => {
    const response = await route.fetch();
    const episodes = await response.json();
    await route.fulfill({
      json: episodes.filter(
        (episode: { id: string }) => episode.id !== "demo-natural-resume",
      ),
    });
  });
  await page.goto("/");
  // The English page publishes the six English recordings: the Chinese sample
  // declares languageVisibility ["zh-cn"] and is filtered out. A broken filter
  // shows seven, and a retired entry reappearing also fails here.
  await expect(page.locator(".sample-collection .sample-panel")).toHaveCount(6);
  await expect(page.locator(".sample-collection")).toContainText(
    "We Choose to Go to the Moon",
  );
  await expect(page.locator(".sample-collection")).toContainText(
    "Tear Down This Wall",
  );
  await page.getByRole("button", { name: "Try a sample", exact: true }).click();
  await expect(page.locator(".source-credit")).toContainText(
    "John F. Kennedy Presidential Library and Museum",
  );
  await expect(
    page.locator(".source-credit").getByRole("link", { name: /Reuse terms/ }),
  ).toHaveAttribute("href", "https://www.usa.gov/government-works");
  // Export links are shown for CC BY recordings; this sample is a government work.
  await expect(
    page.getByRole("link", { name: "Download excerpt" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Download transcript" }),
  ).toHaveCount(0);
  for (const title of [
    "We Choose to Go to the Moon",
    "Tear Down This Wall",
    "John F. Kennedy on the 1952 Senate Race",
    "Earl Warren Runs for President",
    "Robert Moses on Urban Renewal",
    "Richard E. Byrd, Explorer",
  ]) {
    // The CTA already opened the first sample. Reloading that same title would
    // let the assertion match the old heading before the reload completes.
    if (title !== "We Choose to Go to the Moon") {
      await page
        .getByRole("complementary", { name: "Public library" })
        .getByRole("button", { name: new RegExp(title) })
        .click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
    await expect(
      page
        .locator(".player-main")
        .getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    expect(await page.locator(".transcript-line").count()).toBeGreaterThan(10);
    if (title === "We Choose to Go to the Moon")
      await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Pause", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.locator("audio").evaluate((a: HTMLAudioElement) => a.currentTime),
      )
      .toBeGreaterThan(0.2);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollHeight <= innerHeight,
      ),
    ).toBe(true);
  }
});
