import assert from "node:assert/strict";
import test from "node:test";
import { RecentListening } from "../mobile/src/recent-listening";
import type { Episode } from "@aside/engine/core";

const episode = (id: string): Episode => ({
  id,
  title: `Episode ${id}`,
  durationMs: 90000,
  createdAt: "now",
  status: "ready",
  stage: "ready",
  progress: 1,
});
function storage() {
  const values = new Map<string, string>();
  return {
    values,
    async getItem(key: string) {
      return values.get(key) ?? null;
    },
    async setItem(key: string, value: string) {
      values.set(key, value);
    },
    async removeItem(key: string) {
      values.delete(key);
    },
  };
}
test("recent listening survives restart, deduplicates episodes and bounds progress", async () => {
  const disk = storage();
  const first = new RecentListening(disk);
  await first.restore("alice");
  await first.remember(episode("a"), 12345);
  await first.remember(episode("b"), 42000);
  await first.remember(episode("a"), 95000);
  const restored = new RecentListening(disk);
  await restored.restore("alice");
  assert.deepEqual(
    restored.getSnapshot().map((item) => [item.id, item.positionMs]),
    [
      ["a", 90000],
      ["b", 42000],
    ],
  );
  for (let i = 0; i < 8; i++)
    await restored.remember(episode(String(i)), i * 1000);
  assert.equal(restored.getSnapshot().length, 6);
  assert.equal(restored.getSnapshot()[0].id, "7");
});
test("account switching and logout cannot expose another account's recent audio", async () => {
  const disk = storage();
  const recent = new RecentListening(disk);
  await recent.restore("alice");
  const pending = recent.remember(episode("private-alice"), 12000);
  await recent.restore("bob");
  await pending;
  assert.deepEqual(recent.getSnapshot(), []);
  await recent.remember(episode("private-bob"), 25000);
  await recent.clear();
  await recent.restore("bob");
  assert.deepEqual(recent.getSnapshot(), []);
  await recent.restore("alice");
  assert.equal(recent.getSnapshot()[0].id, "private-alice");
});
test("a late cache read cannot repopulate history after logout", async () => {
  let finish!: (value: string) => void;
  const disk = storage();
  disk.values.set("aside.recent.alice", "[]");
  const recent = new RecentListening({
    ...disk,
    getItem: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const restoring = recent.restore("alice");
  await new Promise((resolve) => setImmediate(resolve));
  await recent.clear();
  finish(
    JSON.stringify([{ ...episode("private"), positionMs: 1000, cover: false }]),
  );
  await restoring;
  assert.deepEqual(recent.getSnapshot(), []);
  assert.equal(disk.values.has("aside.recent.alice"), false);
});
test("damaged caches and unfinished uploads do not prevent opening the library", async () => {
  const disk = storage();
  disk.values.set("aside.recent.guest", "not json");
  const recent = new RecentListening(disk);
  await recent.restore("guest");
  assert.deepEqual(recent.getSnapshot(), []);
  await recent.remember({ ...episode("pending"), status: "analyzing" }, 0);
  assert.deepEqual(recent.getSnapshot(), []);
});
