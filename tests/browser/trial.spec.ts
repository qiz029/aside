import { test, expect } from "@playwright/test";

test("guest can listen first; enabling the microphone requests permission before verification", async ({ page }) => {
  let trialReads = 0;
  let proofs = 0;
  let verified = false;
  await page.addInitScript(() => {
    (window as any).permissionRequested = false;
    navigator.mediaDevices.getUserMedia = () => new Promise((resolve) => {
      (window as any).permissionRequested = true;
      (window as any).grantMicrophone = () => resolve(new AudioContext().createMediaStreamDestination().stream);
    });
  });
  await page.route("**/api/health", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...(await response.json()), trial: true, liveConfigured: true } });
  });
  await page.route("**/api/trial", async (route) => {
    if (route.request().method() === "POST") {
      proofs++;
      verified = true;
      await route.fulfill({ json: { ok: true } });
    } else {
      trialReads++;
      await route.fulfill({ json: { verified, enabled: true, siteKey: "test", challenge: "visitor" } });
    }
  });
  await page.route("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "window.turnstile={render(el,options){const b=document.createElement('button');b.textContent='Test verification';b.onclick=()=>options.callback('token');el.append(b);return 'widget'},remove(){}};" }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "体验示例" }).click();
  await expect(page.getByRole("region", { name: "文字稿" })).toBeVisible();
  expect(trialReads).toBe(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "开启麦克风", exact: true }).click();
  expect(await page.evaluate(() => (window as any).permissionRequested)).toBe(true);
  expect(trialReads).toBe(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.evaluate(() => (window as any).grantMicrophone());
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Test verification" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(proofs).toBe(1);
  await page.getByRole("button", { name: "播放", exact: true }).click();
  await expect.poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(false);
});

test("signed-in listener enables the microphone without a Turnstile dialog", async ({ page }) => {
  let trialReads = 0;
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      return context.createMediaStreamDestination().stream;
    };
  });
  await page.route("**/api/health", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...(await response.json()), trial: true, liveConfigured: true } });
  });
  await page.route("**/api/auth/session", (route) => route.fulfill({ json: { user: { id: "signed-in", alias: "Listener", description: "", avatarUrl: null }, emailEnabled: true, googleEnabled: true } }));
  await page.route("**/api/trial", (route) => {
    trialReads++;
    return route.fulfill({ json: { verified: true, enabled: true, siteKey: "test", challenge: "signed-in" } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "体验示例" }).click();
  await expect(page.getByRole("region", { name: "文字稿" })).toBeVisible();
  expect(trialReads).toBe(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "开启麦克风", exact: true }).click();
  await expect.poll(() => trialReads).toBeGreaterThan(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

for (const locale of ["zh-CN", "en-US"]) {
  test.describe(locale, () => {
    test.use({ locale });
    test("trial challenge is shared by parallel voice requests and cancellation sends no paid request", async ({
      page,
    }) => {
      let verified = false,
        paid = 0,
        proofs = 0;
      await page.route("**/api/health", async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          json: { ...(await response.json()), trial: true, liveConfigured: true },
        });
      });
      await page.route("**/api/trial", async (route) => {
        if (route.request().method() === "POST") {
          proofs++;
          verified = true;
          await route.fulfill({ json: { ok: true } });
        } else
          await route.fulfill({
            json: {
              verified,
              enabled: true,
              siteKey: "test",
              challenge: "visitor",
            },
          });
      });
      await page.route(
        "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
        (route) =>
          route.fulfill({
            contentType: "application/javascript",
            body: `window.turnstile={render(el,options){const b=document.createElement('button');b.textContent='Test verification';b.dataset.language=options.language;b.onclick=()=>options.callback('token');el.append(b);return 'widget'},remove(){}};`,
          }),
      );
      await page.route("**/api/test-paid", (route) => {
        paid++;
        return route.fulfill({ json: { ok: true } });
      });
      await page.goto("/");
      // Health config is installed before the library loads; do not race app bootstrap.
      await expect(
        page.getByRole("button", { name: /给思考留一点空间/ }),
      ).toBeVisible();
      await page.evaluate(async () => {
        // @ts-expect-error Browser Vite module URL
        const trial = await import(/* @vite-ignore */ "/src/trial-access.ts");
        trial.configureTrial(true);
        (window as any).trialRun = Promise.all([
          trial.trialFetch("/api/test-paid"),
          trial.trialFetch("/api/test-paid"),
        ])
          .then(() => true)
          .catch(() => false);
      });
      await expect(page.getByRole("dialog")).toHaveCount(1);
      expect(paid).toBe(0);
      await expect(
        page.getByRole("heading", {
          name: locale === "en-US" ? "Try Aside for free" : "开始免费试用",
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Test verification" }),
      ).toHaveAttribute("data-language", locale === "en-US" ? "en" : "zh-cn");
      await page.getByRole("button", { name: "Test verification" }).click();
      expect(await page.evaluate(() => (window as any).trialRun)).toBe(true);
      expect(proofs).toBe(1);
      expect(paid).toBe(2);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      verified = false;
      await page.evaluate(async () => {
        // @ts-expect-error Browser Vite module URL
        const trial = await import(/* @vite-ignore */ "/src/trial-access.ts");
        (window as any).trialRun = trial
          .trialFetch("/api/test-paid")
          .then(() => true)
          .catch(() => false);
      });
      await page
        .getByRole("button", {
          name: locale === "en-US" ? "Keep listening" : "继续收听",
          exact: true,
        })
        .click();
      expect(await page.evaluate(() => (window as any).trialRun)).toBe(false);
      expect(paid).toBe(2);
    });
  });
}
