import { test, expect } from "@playwright/test";

test("Apple sign-in lands in My Space, where the profile is editable, and sign-out returns to guest", async ({
  page,
}) => {
  let user: {
    id: string;
    email: string;
    alias: string;
    description: string;
    avatarUrl: null;
  } | null = null;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const body = route.request().postDataJSON?.() ?? {};
    const send = (value: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    if (path === "/api/health")
      return send({
        liveConfigured: false,
        uploadsEnabled: false,
        microphone: { threshold: 0.02, minSpeechMs: 120, silenceMs: 650 },
        voiceLifecycle: {
          preRollMs: 0,
          graceMs: 5000,
          idleCloseMs: 60000,
          autoResumeMs: 3000,
        },
      });
    if (path === "/api/episodes") return send([]);
    if (path === "/api/space/episodes")
      return send({
        episodes: [],
        pending: [],
        usedThisMonth: 0,
        monthlyLimit: 100,
        usedStorage: 0,
        storageLimit: 20 * 1024 ** 3,
        nextCursor: null,
      });
    if (path === "/api/auth/session")
      return send({ user, googleEnabled: true, appleWebEnabled: true });
    // The provider round trip ends in the server's redirect to My Space.
    if (path === "/api/auth/apple") {
      user = {
        id: "user-1",
        email: "listener@example.com",
        alias: "listener",
        description: "",
        avatarUrl: null,
      };
      return route.fulfill({ status: 302, headers: { location: "/space" } });
    }
    if (path === "/api/profile" && route.request().method() === "PATCH") {
      user = { ...user!, alias: body.alias, description: body.description };
      return send({ user });
    }
    if (path === "/api/auth/logout") {
      user = null;
      return send({ ok: true });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "登录 / 注册" }).click();
  await expect(page.getByLabel("邮箱")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "使用 Google 登录" }),
  ).toHaveAttribute("href", "/api/auth/google");
  await page.getByRole("link", { name: "使用 Apple 登录" }).click();
  // Signing in leads to My Space, not to a profile form.
  await expect(page).toHaveURL(/\/space$/);
  await expect(page.getByRole("dialog", { name: "个人资料" })).toHaveCount(0);
  await page.getByRole("button", { name: "编辑个人资料" }).click();
  await page.getByLabel("昵称").fill("History listener");
  await page.getByLabel("介绍").fill("I listen to history podcasts.");
  await page.getByRole("button", { name: "保存资料" }).click();
  await page.goto("/");
  await expect(page.getByRole("link", { name: "我的空间" })).toBeVisible();
  const enterSpace = page.getByRole("link", {
    name: "Enter My Space",
    exact: true,
  });
  await expect(enterSpace).toHaveAttribute("href", "/space");
  await page.reload();
  await expect(enterSpace).toBeVisible();
  await expect(page.getByRole("button", { name: "登录 / 注册" })).toHaveCount(
    0,
  );
  await enterSpace.click();
  await expect(page).toHaveURL(/\/space$/);
  await expect(
    page.getByRole("button", { name: "编辑个人资料" }),
  ).toContainText("History listener");
  await page.getByRole("button", { name: "编辑个人资料" }).click();
  await expect(page.getByLabel("介绍")).toHaveValue(
    "I listen to history podcasts.",
  );
  await page.getByRole("button", { name: "退出登录" }).click();
  await page.goto("/");
  await expect(page.getByRole("button", { name: "登录 / 注册" })).toBeVisible();
  await expect(page.getByRole("link", { name: "我的空间" })).toHaveCount(0);
});
