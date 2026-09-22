import { test, expect } from "@playwright/test";
import { mockPlayer } from "./remote-fixture";
test.use({ viewport: { width: 390, height: 844 } });
function wav() {
  const data = Buffer.alloc(4844);
  data.write("RIFF");
  data.writeUInt32LE(data.length - 8, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(24000, 24);
  data.writeUInt32LE(48000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(4800, 40);
  return data;
}
async function setup(page: import("@playwright/test").Page) {
  await mockPlayer(page);
  let pending = false,
    completed = false,
    starts = 0,
    deletes = 0,
    offline = true,
    partFailures = Infinity;
  const parts: number[] = [];
  await page.route("**/api/health", (route) =>
    route.fulfill({
      json: {
        uploadsEnabled: true,
        uploadMode: "multipart",
        liveConfigured: false,
        microphone: {},
        voiceLifecycle: {},
      },
    }),
  );
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: {
        user: { id: "owner", alias: "Todd", description: "", avatarUrl: null },
      },
    }),
  );
  await page.route("**/api/space/episodes", (route) =>
    route.fulfill({
      json: {
        episodes: completed
          ? [
              {
                id: "upload-1",
                title: "recording",
                durationMs: 0,
                status: "queued",
                stage: "等待分析",
                progress: 0,
              },
            ]
          : [],
        pending: pending
          ? [
              {
                id: "upload-1",
                title: "recording",
                size: 4844,
                createdAt: new Date().toISOString(),
              },
            ]
          : [],
        usedThisMonth: pending || completed ? 100 : 99,
        monthlyLimit: 100,
        usedStorage: 4844,
        storageLimit: 10000000,
        nextCursor: null,
      },
    }),
  );
  await page.route("**/api/uploads**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/uploads") {
      pending = true;
      starts++;
      return route.fulfill({ json: { id: "upload-1", partSize: 2048 } });
    }
    if (url.pathname.endsWith("/part")) {
      const part = Number(url.searchParams.get("number"));
      parts.push(part);
      if (part === 2 && offline && partFailures-- > 0)
        return route.fulfill({ status: 503, json: { error: "上传连接中断" } });
      return route.fulfill({
        json: { partNumber: part, etag: `part-${part}` },
      });
    }
    if (url.pathname.endsWith("/complete")) {
      expect(route.request().postDataJSON().parts).toEqual(
        [1, 2, 3].map((partNumber) => ({
          partNumber,
          etag: `part-${partNumber}`,
        })),
      );
      pending = false;
      completed = true;
      return route.fulfill({ json: { id: "upload-1" } });
    }
    if (route.request().method() === "DELETE") {
      deletes++;
      pending = false;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: 404, json: { error: "Unexpected upload" } });
  });
  const open = async () => {
    await page.getByRole("button", { name: "音频库", exact: true }).click();
  };
  const begin = async () => {
    await page.goto("/space");
    await open();
    await page.locator(".space-upload-options > summary").click();
    await page.locator(".space-sidebar-file").setInputFiles({
      name: "recording.wav",
      mimeType: "audio/wav",
      buffer: wav(),
    });
  };
  return {
    begin,
    open,
    parts,
    recover: () => {
      offline = false;
    },
    transient: () => {
      partFailures = 1;
    },
    counts: () => ({ starts, deletes }),
  };
}
test("reload resumes only missing parts, validates original bytes, and bypasses new-upload quota", async ({
  page,
}) => {
  const f = await setup(page);
  await f.begin();
  await expect(page.locator(".audio-library-list")).toContainText(
    "上传中断，可继续上传",
    { timeout: 10000 },
  );
  expect(f.parts).toEqual([1, 2, 2, 2]);
  expect(f.counts()).toEqual({ starts: 1, deletes: 0 });
  await page.reload();
  await f.open();
  await page.locator(".audio-library-menu > summary").click();
  const select = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "继续上传", exact: true }).click();
  const different = wav();
  different[different.length - 1] = 1;
  await (
    await select
  ).setFiles({
    name: "recording.wav",
    mimeType: "audio/wav",
    buffer: different,
  });
  await expect(page.locator(".space-sidebar-alert")).toContainText(
    "同一个音频文件",
  );
  await page.locator(".audio-library-menu > summary").click();
  await expect(
    page.getByRole("button", { name: "继续上传", exact: true }),
  ).toBeEnabled();
  expect(f.parts).toEqual([1, 2, 2, 2]);
  f.recover();
  const reselect = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "继续上传", exact: true }).click();
  await (
    await reselect
  ).setFiles({ name: "recording.wav", mimeType: "audio/wav", buffer: wav() });
  await expect(page.locator(".audio-library-list")).toContainText("等待分析");
  expect(f.parts).toEqual([1, 2, 2, 2, 2, 3]);
  expect(f.counts()).toEqual({ starts: 1, deletes: 0 });
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) =>
        key.startsWith("aside.upload."),
      ),
    ),
  ).toEqual([]);
});
test("a transient part failure retries automatically without reserving a second upload", async ({
  page,
}) => {
  const f = await setup(page);
  f.transient();
  await f.begin();
  await expect(page.locator(".audio-library-list")).toContainText("等待分析");
  expect(f.parts).toEqual([1, 2, 2, 3]);
  expect(f.counts()).toEqual({ starts: 1, deletes: 0 });
});
test("explicit cancellation clears the saved resume after the server confirms cancellation", async ({
  page,
}) => {
  const f = await setup(page);
  await f.begin();
  await expect(page.locator(".audio-library-list")).toContainText(
    "上传中断，可继续上传",
    { timeout: 10000 },
  );
  await page.locator(".audio-library-menu > summary").click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator(".audio-library-list")).not.toContainText(
    "recording",
  );
  expect(f.counts()).toEqual({ starts: 1, deletes: 1 });
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) =>
        key.startsWith("aside.upload."),
      ),
    ),
  ).toEqual([]);
});
