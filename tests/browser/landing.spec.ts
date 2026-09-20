import { test, expect, type Page } from "@playwright/test";
import type { Episode } from "@aside/engine/core";

test("public landing explains the interaction and opens the sample without upload prompts", async ({
  page,
}) => {
  await page.route("**/api/health", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      json: { ...(await response.json()), uploadsEnabled: false },
    });
  });
  await page.goto("/");
  const cta = page.getByRole("button", { name: "体验示例" });
  await expect(cta).toBeEnabled();
  await page.screenshot({
    animations: "disabled",
    path: "test-results/landing-thesis-desktop.png",
  });
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await page.getByRole("button", { name: "02 说说你的想法" }).click();
  await expect(page.locator(".preview-question")).toHaveText(
    "但我散步时反而容易走神，这和刚才说的矛盾吗？",
  );
  await page.getByRole("button", { name: "04 接着听" }).click();
  await expect(page.locator(".preview-time")).toHaveText("00:10");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    animations: "disabled",
    path: "test-results/landing-thesis-mobile.png",
  });
  await cta.click();
  await expect(page.getByRole("region", { name: "文字稿" })).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
    { width: 1024, height: 600 },
  ]) {
    await page.setViewportSize(viewport);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollHeight <= innerHeight,
      ),
    ).toBe(true);
    const box = await page
      .getByRole("textbox", { name: "输入消息" })
      .boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    await expect(
      page.getByRole("button", { name: "播放", exact: true }),
    ).toBeInViewport();
  }
});

test("an empty public library stops showing loading placeholders", async ({
  page,
}) => {
  await page.route("**/api/episodes", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
  await expect(page.getByText("暂时没有可收听的示例。")).toBeVisible();
  await expect(page.locator(".sample-skeleton")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "体验示例" })).toBeDisabled();
});

test("sign-in stays visible when the session service fails", async ({
  page,
}) => {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ status: 503, json: { error: "Unavailable" } }),
  );
  await page.goto("/");
  const login = page.getByRole("button", { name: "登录 / 注册" });
  await expect(login).toBeVisible();
  // Read both boxes in the same frame while the hero entrance animates.
  const [ctaBox, loginBox] = await page
    .locator(".hero-actions")
    .evaluate((actions) =>
      [...actions.querySelectorAll("button")].map((button) =>
        button.getBoundingClientRect().toJSON(),
      ),
    );
  expect(loginBox!.height).toBe(ctaBox!.height);
  expect(loginBox!.y).toBeCloseTo(ctaBox!.y, 0);
  await login.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("status")).toHaveText(
    "登录服务暂时不可用，请稍后刷新重试。",
  );
});

// Local libraries differ in how their recordings are filed, so each test
// decides the collections it needs instead of inheriting the machine's.
async function fileEpisodes(
  page: Page,
  collectionOf: (index: number) => string | undefined,
) {
  await page.route("**/api/episodes", async (route) => {
    const episodes: Episode[] = await (await route.fetch()).json();
    await route.fulfill({
      json: episodes.map((episode, index) => {
        const id = collectionOf(index);
        const { collection: _, ...attribution } = episode.attribution ?? {
          publisher: "p",
          author: "a",
          sourceUrl: "https://example.test",
          licenseUrl: "https://example.test",
          license: "l",
          language: "zh",
          excerptStartMs: 0,
          excerptEndMs: 1,
        };
        return {
          ...episode,
          attribution: id
            ? {
                ...attribution,
                collection: { id, title: { zh: `合集 ${id}`, en: id } },
              }
            : attribution,
        };
      }),
    });
  });
}

test("collections each get a headed rail, and a short one hides its arrows", async ({
  page,
}) => {
  await fileEpisodes(page, (index) => (index < 2 ? "short" : "long"));
  await page.goto("/");
  const short = page.getByRole("group", { name: "合集 short" });
  await expect(short.getByRole("heading", { level: 3 })).toContainText(
    "合集 short",
  );
  await expect(short.locator(".sample-panel")).toHaveCount(2);
  await expect(short.getByRole("button", { name: "下一组音频" })).toBeHidden();
  const long = page.getByRole("group", { name: "合集 long" });
  await expect(long.getByRole("button", { name: "下一组音频" })).toBeVisible();
});

test("a collection folds in the library sidebar and stays folded after a reload", async ({
  page,
}) => {
  await fileEpisodes(page, (index) => (index < 2 ? "short" : "long"));
  await page.goto("/");
  await page
    .getByRole("group", { name: "合集 short" })
    .locator(".sample-panel")
    .first()
    .click();
  const sidebar = page.locator(".persistent-library");
  const heading = sidebar.getByRole("button", { name: /合集 short/ });
  await expect(heading).toHaveAttribute("aria-expanded", "true");
  const rows = sidebar.locator(".audio-library-item:visible");
  const before = await rows.count();
  await heading.click();
  await expect(heading).toHaveAttribute("aria-expanded", "false");
  await expect(rows).toHaveCount(before - 2);
  await page.reload();
  await expect(heading).toHaveAttribute("aria-expanded", "false");
  await expect(rows).toHaveCount(before - 2);
});

test("audio panels open directly and can be browsed on desktop and mobile", async ({
  page,
}) => {
  await fileEpisodes(page, () => undefined);
  await page.goto("/");
  const library = page.getByRole("group", { name: "公共音频库" });
  const panels = library.locator(".sample-panel");
  await expect(page.locator(".archive-library")).toHaveCount(0);
  await expect(panels.first()).toContainText(/\d+:\d{2}/);
  await library.scrollIntoViewIfNeeded();
  await panels.first().hover();
  await expect(panels.first().locator("i").first()).toHaveCSS(
    "animation-play-state",
    "running",
  );
  await library.getByRole("button", { name: "下一组音频" }).click();
  await expect
    .poll(() => library.locator(".sample-rail").evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(100);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const last = panels.last();
  await last.scrollIntoViewIfNeeded();
  await last.click();
  await expect(page.locator(".player-main")).toBeVisible();
  await expect(page.getByRole("region", { name: "文字稿" })).toBeVisible();
});

test("scroll story follows native scrolling, reverses, and supports reduced motion", async ({
  page,
}) => {
  await page.goto("/");
  const story = page.locator(".scroll-story");
  const scrollToProgress = async (progress: number) => {
    await story.evaluate((el, p) => {
      const pin = el.querySelector(".story-pin") as HTMLElement;
      window.scrollTo(
        0,
        window.scrollY +
          el.getBoundingClientRect().top +
          p * ((el as HTMLElement).offsetHeight - pin.offsetHeight),
      );
    }, progress);
  };
  for (const [progress, step] of [
    [0.1, 0],
    [0.35, 1],
    [0.6, 2],
    [0.9, 3],
    [0.1, 0],
  ]) {
    await scrollToProgress(progress);
    await expect(story).toHaveAttribute("data-step", String(step));
  }
  await expect(story.locator(".story-agent")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await scrollToProgress(0.6);
  await expect(story).toHaveAttribute("data-step", "2");
  await expect(story.locator(".story-controls")).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(story.locator(".story-pin")).toHaveCSS("position", "relative");
  await story.getByRole("button", { name: "04 接着听" }).click();
  await expect(story.locator(".preview-time")).toHaveText("00:10");
  await story.getByRole("link", { name: "选一段，亲自试试" }).click();
  await expect(page.locator("#sample-title")).toBeInViewport();
});
