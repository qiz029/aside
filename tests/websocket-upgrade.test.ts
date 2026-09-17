import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchWebSocketUpgrade } from "../backend/src/websocket-upgrade.js";

test("successful upgrade clears the handshake deadline without aborting the socket", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal!: AbortSignal;
  const response = new Response();
  const fetcher: typeof fetch = async (_url, init) => {
    signal = init!.signal!;
    return response;
  };
  assert.equal(
    await fetchWebSocketUpgrade(
      "https://example.test/socket",
      { Upgrade: "websocket" },
      5000,
      fetcher,
    ),
    response,
  );
  t.mock.timers.tick(6000);
  assert.equal(signal.aborted, false);
});

test("a stalled handshake is still aborted and a failed handshake clears its timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stalled: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) =>
      init!.signal!.addEventListener("abort", () =>
        reject(init!.signal!.reason),
      ),
    );
  const pending = assert.rejects(
    fetchWebSocketUpgrade("https://example.test/socket", {}, 50, stalled),
    /handshake timed out/,
  );
  t.mock.timers.tick(50);
  await pending;
  let failedSignal!: AbortSignal;
  const failed: typeof fetch = async (_url, init) => {
    failedSignal = init!.signal!;
    throw Error("upstream failed");
  };
  await assert.rejects(
    fetchWebSocketUpgrade("https://example.test/socket", {}, 50, failed),
    /upstream failed/,
  );
  t.mock.timers.tick(100);
  assert.equal(failedSignal.aborted, false);
});
