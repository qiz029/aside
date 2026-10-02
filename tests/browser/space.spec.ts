import { test, expect } from "@playwright/test";
test.use({ viewport: { width: 390, height: 844 } });

function shortWav() {
  const audio = Buffer.alloc(44 + 4800);
  audio.write("RIFF");
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(24000, 24);
  audio.writeUInt32LE(48000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(4800, 40);
  return audio;
}

test("personal Space uploads into a private list and starts analysis automatically", async ({
  page,
}) => {
  const now = new Date().toISOString();
  const episodes: {
    id: string;
    title: string;
    createdAt: string;
    durationMs: number;
    status: string;
    stage: string;
    progress: number;
  }[] = [];
  let usedThisMonth = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if(path === "/api/podcasts/subscriptions") return route.fulfill({json:{subscriptions:[],episodes:[]}});
    const method = route.request().method();
    const send = (value: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    if (path === "/api/health")
      return send({
        uploadsEnabled: true,
        uploadMode: "multipart",
        trial: true,
        liveConfigured: false,
        microphone: {},
        voiceLifecycle: {},
      });
    if (path === "/api/auth/session")
      return send({
        user: {
          id: "account-1",
          alias: "Todd",
          description: "History and ideas",
          avatarUrl: null,
        },
        emailEnabled: true,
        googleEnabled: true,
      });
    if (path === "/api/trial")
      return send({
        verified: true,
        enabled: true,
        siteKey: "test",
        challenge: "account-1",
      });
    if (path === "/api/episodes" && method === "GET") return send(episodes);
    if (path === "/api/space/episodes" && method === "GET")
      return send({
        episodes,
        pending: [],
        usedThisMonth,
        monthlyLimit: 100,
        usedStorage: usedThisMonth * 4800,
        storageLimit: 20 * 1024 ** 3,
        nextCursor: null,
      });
    if (path === "/api/uploads" && method === "POST")
      return send(
        { id: "22222222-2222-4222-8222-222222222222", partSize: 8192 },
        201,
      );
    if (path.endsWith("/part") && method === "PUT")
      return send({ partNumber: 1, etag: "etag" });
    if (path.endsWith("/complete") && method === "POST") {
      episodes.unshift({
        id: "22222222-2222-4222-8222-222222222222",
        title: "My recording",
        createdAt: now,
        durationMs: 0,
        status: "queued",
        stage: "等待分析",
        progress: 0,
      });
      usedThisMonth++;
      return send(episodes[0], 201);
    }
    if (path.startsWith("/api/space/episodes/") && method === "DELETE") {
      episodes.splice(
        episodes.findIndex((episode) => episode.id === path.split("/").at(-1)),
        1,
      );
      return send({ ok: true });
    }
    return send({ error: `Unexpected request: ${method} ${path}` }, 404);
  });
  await page.goto("/space");
  await expect(page.getByRole("heading", { name: "我的空间" })).toBeVisible();
  await expect(page.getByText("你的音频，你可以加入的对话。")).toBeVisible();
  await expect(page.locator(".space-profile, .space-upload")).toHaveCount(0);
  await page.getByRole("button", { name: "音频库", exact: true }).click();
  await expect(page.locator(".space-sidebar-limit")).toContainText(
    "0 / 100 篇本月已用",
  );
  await expect(page.locator(".space-sidebar-limit")).toContainText(
    "单个音频最长 5 小时",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const chooserPromise = page.waitForEvent("filechooser");
  await page
    .locator(".library-drawer")
    .locator("button.space-sidebar-upload")
    .click();
  await (
    await chooserPromise
  ).setFiles({
    name: "My recording.wav",
    mimeType: "audio/wav",
    buffer: shortWav(),
  });

  await expect(page.locator(".audio-library-list")).toContainText("等待分析");
  await expect(page.getByRole("dialog", { name: "我的音频" })).toBeVisible();
  await expect(page.locator(".space-sidebar-limit")).toContainText(
    "1 / 100 篇本月已用",
  );
  await expect(page.getByText("你的音频，你可以加入的对话。")).toBeVisible();
  expect(
    await page.getByRole("button", { name: "上传并自动分析" }).count(),
  ).toBe(0);
  expect(await page.getByRole("button", { name: "开始分析" }).count()).toBe(0);
  page.on("dialog", (dialog) => void dialog.accept());
  await page.locator(".audio-library-menu > summary").click();
  await page
    .locator(".audio-library-list")
    .getByRole("button", { name: "删除" })
    .click();
  await expect(
    page.locator(".audio-library-item").filter({ hasText: "My recording" }),
  ).toHaveCount(0);
});

test("a guest sees the sign-in gate instead of a private library", async ({
  page,
}) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if(path === "/api/podcasts/subscriptions") return route.fulfill({json:{subscriptions:[],episodes:[]}});
    const data =
      path === "/api/auth/session"
        ? { user: null, emailEnabled: true, googleEnabled: true }
        : path === "/api/health"
          ? {
              uploadsEnabled: true,
              trial: false,
              microphone: {},
              voiceLifecycle: {},
            }
          : [];
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  });
  await page.goto("/space");
  await expect(
    page.getByText("请从右上角登录，随时回来继续收听。"),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "我的音频" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "登录 / 注册" })).toBeVisible();
});

test("Space keeps the private library beside its player, transcript, and conversation", async ({
  page,
}) => {
  const episode = {
    id: "33333333-3333-4333-8333-333333333333",
    title: "My saved audio",
    createdAt: new Date().toISOString(),
    durationMs: 60000,
    status: "ready",
    stage: "分析完成",
    progress: 1,
    analysis: {
      version: "test",
      passages: [
        { id: "p1", startMs: 0, endMs: 60000, text: "A saved transcript line" },
      ],
      anchors: [],
      speakers: [],
      summary: "",
      hostStyle: "",
      voice: "masculine",
      voiceReason: "test",
      source: "demo",
    },
  };
  const other = {
    ...episode,
    id: "44444444-4444-4444-8444-444444444444",
    title: "Another private audio",
    analysis: {
      ...episode.analysis,
      passages: [
        {
          id: "p2",
          startMs: 0,
          endMs: 60000,
          text: "A different transcript line",
        },
      ],
    },
  };
  const queued = {
    id: "55555555-5555-4555-8555-555555555555",
    title: "New side upload",
    createdAt: new Date().toISOString(),
    durationMs: 0,
    status: "queued",
    stage: "等待分析",
    progress: 0,
  };
  let uploaded = false;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if(path === "/api/podcasts/subscriptions") return route.fulfill({json:{subscriptions:[],episodes:[]}});
    const method = route.request().method();
    if (path === "/api/uploads" && method === "POST")
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ id: queued.id, partSize: 8192 }),
      });
    if (path.endsWith("/part") && method === "PUT")
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ partNumber: 1, etag: "etag" }),
      });
    if (path.endsWith("/complete") && method === "POST") {
      uploaded = true;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(queued),
      });
    }
    const data =
      path === "/api/auth/session"
        ? {
            user: {
              id: "account-1",
              alias: "Todd",
              description: "",
              avatarUrl: null,
            },
            emailEnabled: true,
            googleEnabled: true,
          }
        : path === "/api/health"
          ? {
              uploadsEnabled: true,
              uploadMode: "multipart",
              trial: false,
              liveConfigured: false,
              microphone: {},
              voiceLifecycle: { autoResumeMs: 3000 },
            }
          : path === "/api/space/episodes"
            ? {
                episodes: uploaded
                  ? [queued, episode, other]
                  : [episode, other],
                pending: [],
                usedThisMonth: uploaded ? 3 : 2,
                monthlyLimit: 100,
                usedStorage: 2,
                storageLimit: 20 * 1024 ** 3,
                nextCursor: null,
              }
            : path === "/api/episodes"
              ? [
                  ...(uploaded ? [queued] : []),
                  episode,
                  other,
                  { ...episode, id: "public-demo", title: "Public sample" },
                ]
              : path === `/api/episodes/${episode.id}` ||
                  path === `/api/episodes/${other.id}`
                ? path.endsWith(other.id)
                  ? other
                  : episode
                : path === `/api/episodes/${episode.id}/checkpoint` ||
                    path === `/api/episodes/${other.id}/checkpoint`
                  ? {
                      positionMs: 0,
                      history: path.includes(other.id)
                        ? [{ role: "user", text: "Second question" }]
                        : [
                            { role: "user", text: "My earlier question" },
                            { role: "assistant", text: "My earlier answer" },
                          ],
                    }
                  : null;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  });
  await page.goto("/space");
  const sidebar = page.locator(".library-drawer");
  await expect(sidebar).toContainText("My saved audio");
  await expect(sidebar).not.toContainText("Public sample");
  await expect(page).toHaveURL(/\/space\?episode=33333333/);
  await expect(page.locator(".space-sidebar, .sidebar")).toHaveCount(0);
  await expect(
    page
      .locator(".player-header")
      .getByRole("button", { name: "音频库", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "文字稿" })).toBeVisible();
  await expect(page.getByText("A saved transcript line")).toBeVisible();
  await page.getByRole("button", { name: "聊两句", exact: true }).click();
  await expect(page.getByRole("log", { name: "对话记录" })).toContainText(
    "My earlier question",
  );
  await expect(page.getByRole("log", { name: "对话记录" })).toContainText(
    "My earlier answer",
  );
  await expect(sidebar.locator(".archive-detail")).toHaveCount(0);
  await expect(sidebar).not.toContainText("Public sample");
  await page.getByRole("button", { name: "音频库", exact: true }).click();
  await page
    .getByRole("button", { name: "选择音频 Another private audio" })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "文字稿" })).toContainText(
    "A different transcript line",
  );
  await expect(
    page.getByRole("button", { name: "音频库", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "聊两句", exact: true }).click();
  await expect(page.getByRole("log", { name: "对话记录" })).toContainText(
    "Second question",
  );
  await expect(page.getByRole("log", { name: "对话记录" })).not.toContainText(
    "My earlier question",
  );
  await page.getByRole("button", { name: "文字稿", exact: true }).click();
  await page.screenshot({
    path: "test-results/archive-private-desktop.png",
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "音频库", exact: true }).click();
  const fileChooser = page.waitForEvent("filechooser");
  await sidebar.locator("button.space-sidebar-upload").click();
  await (
    await fileChooser
  ).setFiles({
    name: "New side upload.wav",
    mimeType: "audio/wav",
    buffer: shortWav(),
  });
  await expect(sidebar.locator(".audio-library-list")).toContainText(
    "等待分析",
  );
  await expect(sidebar.locator(".space-sidebar-limit")).toContainText(
    "3 / 100 篇本月已用",
  );
  await expect(page).toHaveURL(/\/space\?episode=44444444/);
  await sidebar.getByRole("button", { name: "关闭音频库" }).click();
  await expect(page.locator(".space-mobile-feedback")).toContainText("音频已保存");
  await page.screenshot({ path: "test-results/upload-player-mobile.png" });
  await page.locator(".space-mobile-feedback").getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.locator(".space-mobile-feedback")).not.toBeVisible();
  await expect(page.getByRole("region", { name: "文字稿" })).toContainText(
    "A different transcript line",
  );
  await expect(page.locator(".space-profile, .space-upload")).toHaveCount(0);
  await expect(sidebar).toContainText("My saved audio");
  await page.screenshot({
    path: "test-results/archive-private-mobile.png",
    animations: "disabled",
    fullPage: true,
  });
  await page.getByRole("button", { name: "音频库", exact: true }).click();
  await expect(sidebar.locator('.library-collections a[aria-current="page"]')).toHaveText("我的音频");
  await expect(sidebar.locator(".space-sidebar-limit")).toBeVisible();
  await page.screenshot({path: "test-results/private-library-mobile.png"});
  await page.setViewportSize({ width: 1440, height: 1000 });
  const desktopLibrary = page.locator(".persistent-library");
  const row = desktopLibrary.locator(".audio-library-item").filter({hasText: "My saved audio"});
  const rowHeight = (await row.boundingBox())!.height;
  expect(rowHeight).toBeLessThanOrEqual(44);
  const rowBox = (await row.boundingBox())!;
  const actionBox = (await row.locator("summary").boundingBox())!;
  expect(Math.abs(actionBox.y + actionBox.height / 2 - rowBox.y - rowBox.height / 2)).toBeLessThan(2);
  await expect(row.getByRole("button", {name: "删除"})).not.toBeVisible();
  await row.locator("summary").click();
  await expect(row.getByRole("button", {name: "删除"})).toBeVisible();
  expect((await row.boundingBox())!.height).toBe(rowHeight);
  await page.keyboard.press("Escape");
  await expect(row.getByRole("button", {name: "删除"})).not.toBeVisible();
  await expect(row.locator("summary")).toBeFocused();
  await page.screenshot({path: "test-results/private-library-desktop.png"});

});

test("loaded library pages remain visible after the automatic refresh", async ({
  page,
}) => {
  const episode = (id: string, title: string) => ({
    id,
    title,
    createdAt: new Date().toISOString(),
    durationMs: 60000,
    status: "ready",
    stage: "分析完成",
    progress: 1,
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if(path === "/api/podcasts/subscriptions") return route.fulfill({json:{subscriptions:[],episodes:[]}});
    const data =
      path === "/api/auth/session"
        ? {
            user: {
              id: "account-1",
              alias: "Todd",
              description: "",
              avatarUrl: null,
            },
            emailEnabled: true,
            googleEnabled: true,
          }
        : path === "/api/health"
          ? {
              uploadsEnabled: true,
              uploadMode: "multipart",
              trial: false,
              liveConfigured: false,
              microphone: {},
              voiceLifecycle: {},
            }
          : path === "/api/space/episodes"
            ? {
                episodes: [
                  url.searchParams.has("cursor")
                    ? episode("old", "Older recording")
                    : episode("new", "New recording"),
                ],
                pending: [],
                usedThisMonth: 2,
                monthlyLimit: 100,
                usedStorage: 2,
                storageLimit: 20 * 1024 ** 3,
                nextCursor: url.searchParams.has("cursor") ? null : "next",
              }
            : path === "/api/episodes/new" || path === "/api/episodes/old"
              ? episode(
                  path.split("/").at(-1)!,
                  path.endsWith("old") ? "Older recording" : "New recording",
                )
              : path.endsWith("/checkpoint")
                ? { positionMs: 0, history: [] }
                : [];
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  });
  await page.goto("/space");
  await page.getByRole("button", { name: "音频库", exact: true }).click();
  await page.getByRole("button", { name: "加载更多" }).click();
  const sidebar = page.locator(".library-drawer");
  await expect(sidebar.getByText("Older recording")).toBeVisible();
  await page.waitForTimeout(5500);
  await expect(sidebar.getByText("New recording")).toBeVisible();
  await expect(sidebar.getByText("Older recording")).toBeVisible();
});

test("library drawer retains retry, upload cancellation, and analysis progress", async ({
  page,
}) => {
  let pending = [
    { id: "pending-upload", title: "Interrupted upload", size: 1024 },
  ];
  let retried = false;
  const episodes = [
    {
      id: "failed-audio",
      title: "Needs retry",
      durationMs: 0,
      status: "failed",
      stage: "分析失败",
      progress: 0,
    },
    {
      id: "processing-audio",
      title: "Being analyzed",
      durationMs: 0,
      status: "analyzing",
      stage: "正在分析",
      progress: 0.42,
    },
  ];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if(path === "/api/podcasts/subscriptions") return route.fulfill({json:{subscriptions:[],episodes:[]}});
    const method = route.request().method();
    if (method === "DELETE" && path.includes("pending-upload")) pending = [];
    if (method === "POST" && path.includes("failed-audio")) retried = true;
    const data =
      path === "/api/auth/session"
        ? {
            user: { id: "test", alias: "Listener" },
            emailEnabled: true,
            googleEnabled: false,
          }
        : path === "/api/health"
          ? { uploadsEnabled: true, trial: false }
          : path === "/api/space/episodes"
            ? {
                episodes,
                pending,
                usedThisMonth: 2,
                monthlyLimit: 100,
                usedStorage: 0,
                storageLimit: 100000,
                nextCursor: null,
              }
            : path === "/api/episodes"
              ? []
              : { ok: true };
    await route.fulfill({ json: data });
  });
  await page.goto("/space");
  await page.getByRole("button", { name: "音频库", exact: true }).click();
  const library = page.getByRole("dialog", { name: "我的音频" });
  await library
    .locator(".audio-library-item")
    .filter({ hasText: "Interrupted upload" })
    .locator("summary")
    .click();
  await library.getByRole("button", { name: "取消", exact: true }).click();
  await expect(
    library.getByRole("button", { name: "选择音频 Interrupted upload" }),
  ).toHaveCount(0);
  await library
    .locator(".audio-library-item")
    .filter({ hasText: "Needs retry" })
    .locator("summary")
    .click();
  await library.getByRole("button", { name: "重试分析" }).click();
  expect(retried).toBe(true);
  await expect(library.getByRole("progressbar")).toHaveAttribute("value", "42");
  await expect(
    library.getByRole("button", { name: "听这段", exact: true }),
  ).toHaveCount(0);
});
