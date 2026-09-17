import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { LiveControl } from "../backend/src/live-control.js";
import { attachLiveSideband } from "../backend/src/live-sideband.js";
import { readLiveControl } from "../frontend/src/live-control-stream.js";
import { createPlayerConfig } from "@aside/engine/player";
import type { Analysis } from "@aside/engine/core";
import type { LiveControlEvent } from "@aside/engine/contracts";
const analysis: Analysis = {
  version: "1",
  source: "demo",
  summary: "",
  hostStyle: "",
  speakers: [],
  voice: "masculine",
  voiceReason: "",
  passages: [],
  anchors: [],
};
const player = {
  version: 0,
  sequence: 0,
  revision: 0,
  positionMs: 1000,
  wasPlaying: true,
  audibleSource: "podcast" as const,
  config: createPlayerConfig(),
};
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

test("one authenticated session stream carries multiple decisions, heartbeat and graceful close", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const calls: string[] = [],
    events: LiveControlEvent[] = [],
    notes: string[] = [];
  const c = new LiveControl(
    "session",
    { player, debug: true },
    analysis,
    [],
    {
      answer: async (_a, q) => {
        calls.push(q.history.at(-1)!.text);
        return {
          action: "ignore",
          revision: q.revision,
          answer: "",
          tools: [],
          sources: [],
        };
      },
    },
    (text) => notes.push(text),
  );
  const response = c.subscribe();
  const reading = readLiveControl(response, (event) => events.push(event));
  assert.equal(c.subscribe().status, 409);
  assert.equal(c.update({ sessionId: "wrong", player }), false);
  assert.equal(
    c.update({ sessionId: "session", player: { ...player, sequence: 1 } }),
    true,
  );
  c.receive({
    type: "session.input_transcript.delta",
    delta: "Dinner plans",
    start_ms: 0,
    end_ms: 100,
  });
  t.mock.timers.tick(160);
  await flush();
  c.receive({
    type: "session.input_transcript.delta",
    delta: "Other speech",
    start_ms: 2000,
    end_ms: 2100,
  });
  t.mock.timers.tick(160);
  await flush();
  t.mock.timers.tick(15000);
  await flush();
  c.close();
  await reading;
  assert.deepEqual(calls, ["Dinner plans", "Other speech"]);
  assert.equal(events.filter((e) => e.type === "decision").length, 2);
  assert.ok(events.some((e) => e.type === "heartbeat"));
  assert.equal(events.at(-1)?.type, "closed");
  assert.equal(c.update({ sessionId: "session", player }), false);
  assert.deepEqual(notes, []);
});

test("disconnect cancels in-flight work and no transcript is processed before subscription", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let signal: AbortSignal | undefined;
  const c = new LiveControl(
    "session",
    { player, debug: false },
    analysis,
    [],
    {
      answer: async (_a, _q, s) => {
        signal = s;
        return new Promise(() => {});
      },
    },
    () => {},
  );
  c.receive({ type: "session.input_transcript.delta", delta: "before" });
  t.mock.timers.tick(160);
  assert.equal(signal, undefined);
  const response = c.subscribe();
  c.receive({ type: "session.input_transcript.delta", delta: "during" });
  t.mock.timers.tick(160);
  await flush();
  assert.equal((signal as AbortSignal | undefined)?.aborted, false);
  await response.body!.cancel();
  assert.equal((signal as AbortSignal | undefined)?.aborted, true);
  c.close();
  assert.equal(c.subscribe().status, 409);
});

test("sideband loss is an explicit stream error and a stalled tab has a bounded queue", async () => {
  const make = () =>
    new LiveControl(
      "session",
      { player, debug: false },
      analysis,
      [],
      {
        answer: async () => {
          throw Error("unexpected");
        },
      },
      () => {},
    );
  const c = make(),
    response = c.subscribe();
  c.close("Sideband disconnected");
  await assert.rejects(
    readLiveControl(response, () => {}),
    /Sideband disconnected/,
  );
  const stalled = make();
  const stream = stalled.subscribe();
  for (let i = 0; i < 80; i++)
    stalled.receive({ type: "session.input_transcript.delta", delta: "a" });
  const events: LiveControlEvent[] = [];
  await readLiveControl(stream, (e) => events.push(e));
  assert.ok(events.length <= 68);
  assert.equal(events.at(-1)?.type, "closed");
});

test("NDJSON parser handles split UTF-8, multiple results, malformed frames and early EOF", async () => {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(
    '{"type":"observing","version":0,"text":"你好"}\n{"type":"closed"}',
  );
  const response = new Response(
    new ReadableStream({
      start(c) {
        for (const byte of bytes) c.enqueue(new Uint8Array([byte]));
        c.close();
      },
    }),
    { headers: { "Content-Type": "application/x-ndjson" } },
  );
  const events: LiveControlEvent[] = [];
  await readLiveControl(response, (e) => events.push(e));
  assert.deepEqual(events, [
    { type: "observing", version: 0, text: "你好" },
    { type: "closed" },
  ]);
  await assert.rejects(
    readLiveControl(new Response("{}"), () => {}),
    /unavailable/,
  );
  await assert.rejects(
    readLiveControl(
      Response.json({ error: "Denied" }, { status: 403 }),
      () => {},
    ),
    /Denied/,
  );
  for (const body of [
    '{"type":"heartbeat"}\n',
    '{"type":"unknown"}\n',
    "x".repeat(128001),
  ])
    await assert.rejects(
      readLiveControl(
        new Response(body, {
          headers: { "Content-Type": "application/x-ndjson" },
        }),
        () => {},
      ),
    );
});

test("Node sideband authenticates, receives transcript frames and reports connection loss", async () => {
  const socket = new EventEmitter() as WebSocket;
  const sent: string[] = [],
    received: unknown[] = [];
  let closed = 0;
  socket.send = (value: unknown) => {
    sent.push(String(value));
  };
  socket.close = () => {
    closed++;
  };
  const connecting = attachLiveSideband(
    "test-key",
    "session/a",
    (e) => received.push(e),
    () => {
      closed++;
    },
    (url, options) => {
      assert.match(url, /session%2Fa\/attach$/);
      assert.equal(options.headers?.Authorization, "Bearer test-key");
      return socket;
    },
  );
  socket.emit("open");
  const port = await connecting;
  socket.emit(
    "message",
    Buffer.from('{"type":"session.input_transcript.delta","delta":"Stop"}'),
  );
  socket.emit("message", Buffer.from("bad JSON"));
  port.send("test");
  port.close();
  socket.emit("close");
  assert.equal(received.length, 1);
  assert.deepEqual(sent, ["test"]);
  assert.equal(closed, 2);
  for (const event of ["close", "error"]) {
    const failed = new EventEmitter() as WebSocket;
    const connect = attachLiveSideband(
      "test",
      "failed",
      () => {},
      () => {},
      () => failed,
    );
    failed.emit(event, Error("failed"));
    await assert.rejects(connect);
  }
});
