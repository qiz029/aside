import { test, expect } from "@playwright/test";
import { mockPlayer, episodes } from "./remote-fixture";
const show = {
  id: "123",
  title: "A curious podcast",
  author: "Test host",
  country: "US",
  feedUrl: "https://feeds.example.com/show",
  sourceUrl: "https://podcasts.apple.com/us/podcast/id123",
};
const item = {
  guid: "one",
  title: "A fresh episode",
  description: "An episode to explore",
  durationMs: 60000,
  publishedAt: "2026-10-01T00:00:00Z",
  audioUrl: "https://media.example.com/audio.mp3",
  mimeType: "audio/mpeg",
};
for (const width of [1440, 390])
  test(`search, subscribe and play without uploading at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockPlayer(page);
    let subscribed = false;
    const imports: unknown[] = [];
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({
        json: {
          user: {
            id: "test-user",
            alias: "Listener",
            description: "",
            avatarUrl: null,
          },
        },
      }),
    );
    await page.route("**/api/space/episodes", (route) =>
      route.fulfill({
        json: {
          episodes: [],
          pending: [],
          usedThisMonth: 0,
          monthlyLimit: 100,
          usedStorage: 0,
          storageLimit: 1e9,
          nextCursor: null,
        },
      }),
    );
    await page.route("**/api/podcasts/**", (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (url.pathname.endsWith("/search"))
        return route.fulfill({ json: { shows: [show] } });
      if (url.pathname.endsWith("/shows/123"))
        return route.fulfill({
          json: { show, episodes: [item], checkedAt: Date.now(), stale: false },
        });
      if (url.pathname.endsWith("/subscriptions/123")) {
        subscribed = req.method() === "PUT";
        return route.fulfill({ json: { ok: true } });
      }
      if (url.pathname.endsWith("/subscriptions"))
        return route.fulfill({
          json: {
            subscriptions: subscribed
              ? [
                  {
                    show,
                    subscribedAt: Date.now(),
                    checkedAt: Date.now(),
                    stale: false,
                  },
                ]
              : [],
            episodes: subscribed ? [{ show, episode: item }] : [],
          },
        });
      if (url.pathname.endsWith("/import")) {
        imports.push(req.postDataJSON());
        return route.fulfill({
          json: { episode: episodes[0], positionMs: 12000 },
        });
      }
      return route.fulfill({
        status: 404,
        json: { error: "Unexpected route" },
      });
    });
    await page.goto("/space");
    await page.getByRole("searchbox", { name: "搜索播客" }).fill("curious");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByRole("button", { name: /A curious podcast/ }).click();
    await expect(
      page.getByText("A fresh episode", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "订阅", exact: true }).click();
    await expect(page.getByRole("button", { name: "取消订阅" })).toBeVisible();
    await page.getByRole("button", { name: "返回", exact: true }).click();
    await expect(
      page.getByText("A fresh episode", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: `/tmp/aside-podcasts-${width}.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "收听", exact: true }).click();
    await expect(page).toHaveURL(/episode=remote-a/);
    await page.getByRole("button", { name: "找播客", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "找播客", exact: true }),
    ).toBeVisible();
    const dialog = page.getByRole("dialog", { name: "找播客", exact: true });
    const url =
      "https://podcasts.apple.com/us/podcast/example/id123?i=456&t=12";
    await dialog.getByRole("textbox", { name: "播客单集链接" }).fill(url);
    await dialog.getByRole("button", { name: "直接收听", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(imports).toEqual([
      { showId: "123", country: "US", guid: "one" },
      { url },
    ]);
    await expect
      .poll(() =>
        page
          .locator("audio")
          .first()
          .evaluate((audio: HTMLAudioElement) => audio.currentTime),
      )
      .toBeGreaterThanOrEqual(12);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
