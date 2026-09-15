import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CheckpointSync,
  CheckpointConflict,
} from "../player-runtime/src/checkpoint-sync.js";
import type { Checkpoint } from "../engine/src/contracts.js";
const value = (positionMs: number, version = 0): Checkpoint => ({
  positionMs,
  history: [],
  version,
});
test("switching episodes while a cache write waits cannot write old progress with the new version", async () => {
  let finish!: () => void;
  const writes: string[] = [];
  const sync = new CheckpointSync({
    read: async () => value(0),
    cache: async () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    write: async (id, next) => {
      writes.push(id);
      return next;
    },
  });
  await sync.load("old");
  const pending = sync.save(value(10));
  await new Promise((resolve) => setImmediate(resolve));
  await sync.load("new");
  finish();
  await pending;
  assert.deepEqual(writes, []);
});
test("choosing remote state discards queued local saves", async () => {
  let release!: () => void;
  const writes: number[] = [];
  const sync = new CheckpointSync({
    read: async () => value(0),
    cache: async () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    write: async (_id, next) => {
      writes.push(next.positionMs);
      return next;
    },
  });
  await sync.load("ep");
  sync.conflict = value(9000, 2);
  const pending = sync.save(value(1000));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sync.useRemote()?.positionMs, 9000);
  release();
  await pending;
  assert.deepEqual(writes, []);
});
test("two devices cannot silently overwrite checkpoints; explicit keep retries the observed version", async () => {
  let remote = value(0),
    writes = 0;
  const store = {
    read: async () => remote,
    write: async (_id: string, next: Checkpoint) => {
      if (next.version !== remote.version) throw new CheckpointConflict();
      remote = { ...next, version: remote.version! + 1 };
      writes++;
      return remote;
    },
  };
  const a = new CheckpointSync(store),
    b = new CheckpointSync(store);
  await a.load("ep");
  await b.load("ep");
  await a.save(value(1000));
  await b.save(value(2000));
  assert.equal(remote.positionMs, 1000);
  assert.equal(b.conflict?.positionMs, 1000);
  await b.save(value(3000));
  assert.equal(writes, 1);
  await b.keepLocal(value(3000));
  assert.equal(remote.positionMs, 3000);
  assert.equal(remote.version, 2);
});
test("writes serialize and switching episodes ignores a late response", async () => {
  let version = 0;
  const seen: number[] = [];
  const sync = new CheckpointSync({
    read: async () => value(0),
    write: async (_id, next) => {
      await Promise.resolve();
      assert.equal(next.version, version);
      seen.push(next.positionMs);
      return { ...next, version: ++version };
    },
  });
  await sync.load("a");
  await Promise.all([sync.save(value(1)), sync.save(value(2))]);
  assert.deepEqual(seen, [1, 2]);
});

test("late writes cannot replace the version of a newly selected episode", async () => {
  let finish!: () => void;
  const writes: { id: string; version: number | undefined }[] = [];
  const sync = new CheckpointSync({
    read: async (id) => value(0, id === "b" ? 5 : 0),
    write: async (id, next) => {
      writes.push({ id, version: next.version });
      if (id === "a")
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return { ...next, version: (next.version ?? 0) + 1 };
    },
  });
  await sync.load("a");
  const old = sync.save(value(10));
  await new Promise((resolve) => setImmediate(resolve));
  await sync.load("b");
  finish();
  await old;
  await sync.save(value(20));
  assert.deepEqual(writes, [
    { id: "a", version: 0 },
    { id: "b", version: 5 },
  ]);
});
