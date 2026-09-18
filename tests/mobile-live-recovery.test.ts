import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LiveSessionJournal,
  type RememberedLive,
} from "../mobile/src/live-session-journal.js";

const previous: RememberedLive = {
  token: "account-a",
  episodeId: "episode",
  sessionId: "old",
};
function fixture(initial: string | null = JSON.stringify(previous)) {
  let value = initial;
  return {
    storage: {
      read: async () => value,
      write: async (next: string) => {
        value = next;
      },
      remove: async () => {
        value = null;
      },
    },
    value: () => value,
  };
}
test("a new app process closes only its own remembered Live session", async () => {
  const f = fixture();
  const journal = new LiveSessionJournal(f.storage),
    calls: RememberedLive[] = [];
  await journal.recover("account-a", async (entry) => {
    calls.push(entry);
  });
  await journal.recover("account-a", async (entry) => {
    calls.push(entry);
  });
  assert.deepEqual(calls, [previous]);
  assert.equal(f.value(), null);
});
test("offline recovery preserves the lease for a later explicit attempt", async () => {
  const f = fixture(),
    journal = new LiveSessionJournal(f.storage);
  await assert.rejects(
    journal.recover("account-a", async () => {
      throw Error("offline");
    }),
    /offline/,
  );
  assert.equal(f.value(), JSON.stringify(previous));
  await journal.recover("account-a", async () => {});
  assert.equal(f.value(), null);
});
test("another account and corrupt storage cannot authorize session closure", async () => {
  for (const raw of [
    JSON.stringify(previous),
    "{broken",
    JSON.stringify({ token: "account-b" }),
  ]) {
    const f = fixture(raw),
      journal = new LiveSessionJournal(f.storage);
    await journal.recover("account-b", async () => {
      assert.fail("unauthorized closure");
    });
    assert.equal(f.value(), raw);
  }
});

test("logout removes its recovery credential without erasing another account's journal", async () => {
  const f = fixture(),
    journal = new LiveSessionJournal(f.storage);
  await journal.forget("account-b");
  assert.equal(f.value(), JSON.stringify(previous));
  await journal.forget("account-a");
  assert.equal(f.value(), null);
});
test("late old-session cleanup cannot erase a replacement session journal", async () => {
  const f = fixture(),
    journal = new LiveSessionJournal(f.storage);
  let finish!: () => void;
  const recovery = journal.recover(
    "account-a",
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const replacement = { ...previous, sessionId: "new" };
  const remembered = journal.remember(replacement);
  finish();
  await Promise.all([recovery, remembered]);
  await journal.forget("account-a", "old");
  assert.equal(f.value(), JSON.stringify(replacement));
});
