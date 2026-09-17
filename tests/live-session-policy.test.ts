import { test } from "node:test";
import assert from "node:assert/strict";
import { liveSessionPolicy } from "../backend/src/live-session-policy.js";

test("session limits retain the guest trial and opt accounts into a configured duration", () => {
  assert.deepEqual(liveSessionPolicy({}, false), {
    seconds: 120,
    intentCalls: 30,
  });
  assert.deepEqual(liveSessionPolicy({}, true), {
    seconds: 120,
    intentCalls: 30,
  });
  const env = { ASIDE_LIVE_ACCOUNT_SESSION_SECONDS: " 1800 " };
  assert.deepEqual(liveSessionPolicy(env, false), {
    seconds: 120,
    intentCalls: 30,
  });
  assert.deepEqual(liveSessionPolicy(env, true), {
    seconds: 1800,
    intentCalls: 450,
  });
  assert.deepEqual(
    liveSessionPolicy({ ASIDE_LIVE_ACCOUNT_SESSION_SECONDS: "121" }, true),
    { seconds: 121, intentCalls: 31 },
  );
  assert.equal(
    liveSessionPolicy({ ASIDE_LIVE_ACCOUNT_SESSION_SECONDS: " " }, true)
      .seconds,
    120,
  );
  assert.equal(
    liveSessionPolicy({ ASIDE_LIVE_ACCOUNT_SESSION_SECONDS: "3600" }, true)
      .seconds,
    3600,
  );
});

test("invalid account duration fails early rather than silently disabling the bound", () => {
  for (const value of ["0", "119", "3601", "120.5", "NaN", "Infinity"])
    assert.throws(
      () =>
        liveSessionPolicy({ ASIDE_LIVE_ACCOUNT_SESSION_SECONDS: value }, true),
      /ASIDE_LIVE_ACCOUNT_SESSION_SECONDS/,
    );
});
