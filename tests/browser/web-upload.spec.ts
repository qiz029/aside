import { test, expect } from "@playwright/test";
import { episodes, mockPlayer } from "./remote-fixture";
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
    partFailures = Infinity,
    ready = false,
    held = false;
  let releasePart: (() => void) | undefined;
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
                ...(ready ? episodes[0] : {}),
                id: "upload-1",
                title: "recording",
                durationMs: ready ? 60000 : 0,
                status: ready ? "ready" : "queued",
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
      if (held)
        await new Promise<void>((resolve) => {
          releasePart = resolve;
        });
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
    ready: () => {
      ready = true;
    },
    hold: () => {
      held = true;
    },
    release: () => {
      held = false;
      releasePart?.();
    },
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
  await expect(
    page.locator(".library-drawer .space-sidebar-alert"),
  ).toContainText("同一个音频文件");
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

test("empty Space uploads in one click and keeps a visible path through analysis to listening", async ({
  page,
}) => {
  const f = await setup(page);
  f.recover();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/space");
  const stage = page.locator(".space-stage-empty");
  await expect(
    stage.getByRole("button", { name: "选择音频", exact: true }),
  ).toBeEnabled();
  await page.screenshot({ path: "test-results/upload-after-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/upload-after-mobile.png" });
  const chooser = page.waitForEvent("filechooser");
  await stage.getByRole("button", { name: "选择音频", exact: true }).click();
  await (
    await chooser
  ).setFiles({ name: "recording.wav", mimeType: "audio/wav", buffer: wav() });
  await expect(stage).toContainText("音频已保存，正在自动分析");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.screenshot({ path: "test-results/upload-saved-mobile.png" });
  f.ready();
  await page.route("**/api/episodes/upload-1", (route) =>
    route.fulfill({
      json: { ...episodes[0], id: "upload-1", title: "recording" },
    }),
  );
  await page.route("**/api/episodes/upload-1/checkpoint", (route) =>
    route.fulfill({ json: { positionMs: 0, history: [] } }),
  );
  await expect(stage.getByRole("button", { name: "开始收听" })).toBeVisible({
    timeout: 10000,
  });
  await expect(page).toHaveURL(/\/space$/);
  await expect(stage).toContainText("分析完成，可以开始收听和对话了。");
  expect(f.counts()).toEqual({ starts: 1, deletes: 0 });
  await stage.getByRole("button", { name: "开始收听" }).click();
  await expect(page).toHaveURL(/episode=upload-1/);
  await expect(page.getByRole("region", { name: "文字稿" })).toContainText(
    "First passage",
  );
});

test("dropping audio uploads directly and a full quota explains why selection is disabled", async ({
  page,
}) => {
  const f = await setup(page);
  f.recover();
  await page.goto("/space");
  await expect(page.locator(".space-dropzone .btn")).toBeEnabled();
  const data = await page.evaluateHandle(
    (bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Uint8Array(bytes)], "recording.wav", {
          type: "audio/wav",
        }),
      );
      return transfer;
    },
    [...wav()],
  );
  await page
    .locator(".space-dropzone")
    .dispatchEvent("drop", { dataTransfer: data });
  await expect(page.locator(".space-stage-feedback")).toContainText(
    "音频已保存",
  );
  await expect(page.locator(".space-dropzone")).toContainText(
    "本月上传额度已用完",
  );
  await expect(page.locator(".space-dropzone .btn")).toBeDisabled();
  await data.dispose();
});

test("invalid files are explained beside the picker without reserving an upload", async ({
  page,
}) => {
  const f = await setup(page);
  await page.goto("/space");
  await expect(page.locator(".space-dropzone .btn")).toBeEnabled();
  await page.locator('input[type="file"]').setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.alloc(100),
  });
  await expect(
    page.locator(".space-stage-feedback [role=alert]"),
  ).toContainText("请选择音频文件");
  await expect(page.locator(".space-dropzone .btn")).toBeEnabled();
  expect(f.counts()).toEqual({ starts: 0, deletes: 0 });
});

test("cancelling an active upload restores the picker without an error alert", async ({
  page,
}) => {
  const f = await setup(page);
  f.hold();
  await f.begin();
  const library = page.locator(".library-drawer");
  await expect(library.getByRole("button", { name: "取消上传" })).toBeVisible();
  const progress = library.getByRole("progressbar", { name: "上传进度" });
  await expect(progress).toHaveAttribute("aria-valuenow", "0");
  await expect(progress.locator("span")).toHaveAttribute("style", "width: 0%;");
  await library.getByRole("button", { name: "关闭音频库" }).click();
  await page
    .locator(".space-stage-feedback")
    .getByRole("button", { name: "取消上传" })
    .click();
  await expect(page.locator(".space-stage-feedback")).toContainText(
    "上传已取消",
  );
  f.release();
  await expect(library.getByRole("alert")).toHaveCount(0);
  await expect(library.locator("button.space-sidebar-upload")).toBeEnabled();
  expect(f.counts()).toEqual({ starts: 1, deletes: 1 });
});
