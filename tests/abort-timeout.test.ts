import { test } from "node:test";
import assert from "node:assert/strict";
import { withAbortTimeout } from "@aside/player-runtime/abort-timeout";

test("control timeout works without browser AbortSignal helpers and releases its timer", async (t) => {
  const unavailable = () => {
    throw Error("Browser AbortSignal helper unavailable");
  };
  t.mock.method(AbortSignal, "any", unavailable);
  t.mock.method(AbortSignal, "timeout", unavailable);
  let expire!: () => void,
    cancelled = false;
  const clock = {
    now: () => 0,
    after(ms: number, cb: () => void) {
      assert.equal(ms, 5000);
      expire = cb;
      return () => {
        cancelled = true;
      };
    },
  };
  const request = withAbortTimeout(
    new AbortController().signal,
    5000,
    async (signal) =>
      new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(Error("Timed out")), {
          once: true,
        }),
      ),
    clock,
  );
  expire();
  await assert.rejects(request, /Timed out/);
  assert.equal(cancelled, true);
});

test("session cancellation also aborts pending acknowledgements; success removes the timer", async () => {
  for (const before of [true, false]) {
    const owner = new AbortController();
    if (before) owner.abort();
    let child!: AbortSignal;
    const request = withAbortTimeout(owner.signal, 5000, async (signal) => {
      child = signal;
    });
    if (!before) owner.abort();
    await request;
    assert.equal(child.aborted, true);
  }
  let cancelled = false;
  assert.equal(
    await withAbortTimeout(new AbortController().signal, 5000, async () => 42, {
      now: () => 0,
      after: () => () => {
        cancelled = true;
      },
    }),
    42,
  );
  assert.equal(cancelled, true);
});
