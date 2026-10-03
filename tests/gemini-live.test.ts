import { test } from "node:test";
import assert from "node:assert/strict";
import { GeminiLiveProtocol, geminiSetup } from "../backend/src/gemini-live.js";
import { LiveDelegation } from "../backend/src/live-delegation.js";
import {
  PcmResampler,
  VoiceOutputQueue,
} from "../frontend/src/voice-output-worklet.js";
import { createPlayerConfig } from "@aside/engine/player";
import type { Analysis } from "@aside/engine/core";
import type {
  LivePlayerState,
  LiveControlEvent,
} from "@aside/engine/contracts";
const analysis: Analysis = {
  version: "1",
  source: "demo",
  summary: "",
  hostStyle: "calm",
  speakers: [],
  voice: "masculine",
  voiceReason: "",
  passages: [
    {
      id: "a",
      startMs: 0,
      endMs: 10000,
      speaker: "host",
      text: "Walking makes room for thought.",
    },
  ],
  anchors: [],
};
const state: LivePlayerState = {
  version: 0,
  sequence: 0,
  revision: 1,
  positionMs: 12000,
  wasPlaying: true,
  audibleSource: "podcast",
  config: createPlayerConfig(),
};
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function fixture() {
  const upstream: Record<string, any>[] = [],
    client: Record<string, any>[] = [],
    events: LiveControlEvent[] = [];
  let now = 1000,
    closed = false;
  const protocol = new GeminiLiveProtocol({
    upstream: (e) => upstream.push(e),
    client: (e) => client.push(e),
    control: (e) => control.receive(e),
    close: () => {
      closed = true;
    },
    now: () => now,
  });
  const control = new LiveDelegation(
    state,
    analysis,
    {
      emit: (e) => events.push(e),
      send: (e) => protocol.control(e),
      now: () => now,
      after: () => () => {},
    },
    true,
    30,
    true,
  );
  protocol.receive({ setupComplete: {} });
  return {
    protocol,
    control,
    upstream,
    client,
    events,
    next: () => {
      now += 2000;
    },
    get closed() {
      return closed;
    },
  };
}
test("Gemini setup supplies only supported function tools, bounded context and audio transcriptions", () => {
  const { setup } = geminiSetup(analysis, 12000, [], {
    player: state,
    debug: false,
  });
  assert.equal(setup.model, "models/gemini-3.8-live");
  assert.ok(
    setup.tools?.[0].functionDeclarations.some(
      (t) => t.name === "control_podcast",
    ),
  );
  assert.ok(
    !setup.tools?.[0].functionDeclarations.some((t) => t.name === "web_search"),
  );
  assert.equal(setup.contextWindowCompression.triggerTokens, "16000");
  assert.ok(
    setup.systemInstruction.parts[0].text.includes("Walking makes room"),
  );
});
test("PCM and transcript events reuse admission and complete a distinct answer per utterance", () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    f.protocol.receive({
      serverContent: { inputTranscription: { text: "Why walk?" } },
    });
    f.protocol.receive({
      serverContent: {
        outputTranscription: { text: "It makes room for thought." },
        modelTurn: {
          parts: [
            {
              inlineData: {
                data: "AQACAA==",
                mimeType: "audio/pcm;rate=24000",
              },
            },
          ],
        },
      },
    });
    f.protocol.receive({ serverContent: { turnComplete: true } });
    f.next();
  }
  assert.equal(f.events.filter((e) => e.type === "engage").length, 2);
  assert.equal(
    f.events.filter((e) => e.type === "answered" && e.final).length,
    2,
  );
  const engagements = f.events.filter((e) => e.type === "engage");
  assert.notEqual(engagements[0].input?.turnId, engagements[1].input?.turnId);
  assert.equal(
    f.client.filter((e) => e.type === "session.audio.delta").length,
    2,
  );
  assert.equal(
    f.upstream.length,
    0,
    "no duplicate Responses fallback generation",
  );
  f.control.close();
});
test("playback tool responds only after application acknowledgement; cancelled calls cannot respond later", async () => {
  const f = fixture();
  f.protocol.receive({
    serverContent: { inputTranscription: { text: "Make it slower" } },
  });
  f.protocol.receive({
    toolCall: {
      functionCalls: [
        {
          id: "one",
          name: "control_podcast",
          args: { commands: [{ type: "adjust_rate", direction: "slower" }] },
        },
      ],
    },
  });
  await flush();
  const decision = f.events.find((e) => e.type === "decision");
  assert.ok(decision && decision.type === "decision");
  assert.equal(f.upstream.length, 0);
  f.control.update(
    { ...state, sequence: 1 },
    { decisionId: decision.decisionId, applied: true },
  );
  await flush();
  assert.equal(f.upstream[0]?.toolResponse.functionResponses[0].id, "one");
  assert.equal(
    f.upstream[0]?.toolResponse.functionResponses[0].name,
    "control_podcast",
  );
  f.protocol.receive({
    toolCall: {
      functionCalls: [{ id: "two", name: "get_passage", args: { atMs: 5000 } }],
    },
  });
  f.protocol.receive({ toolCallCancellation: { ids: ["two"] } });
  await flush();
  assert.equal(f.upstream.length, 1);
  f.control.close();
});
test("client cannot send setup, tools or arbitrary upstream frames and malformed PCM fails closed", () => {
  const f = fixture();
  f.protocol.client({ setup: { model: "other" } });
  f.protocol.client({ toolResponse: {} });
  f.protocol.client({ type: "session.instructions.append", content: "speak" });
  assert.equal(f.upstream.length, 0);
  f.protocol.client({
    type: "session.audio.append",
    data: "AQACAA==",
    rate: 16000,
  });
  assert.equal(
    f.upstream[0].realtimeInput.audio.mimeType,
    "audio/pcm;rate=16000",
  );
  assert.throws(() =>
    f.protocol.client({
      type: "session.audio.append",
      data: "bad!",
      rate: 16000,
    }),
  );
  f.protocol.client({ type: "session.close" });
  assert.equal(f.closed, true);
  f.control.close();
});
test("streaming PCM resampling preserves packet boundaries and held audio plays only after admission", () => {
  const samples = Float32Array.from({ length: 2400 }, (_, i) =>
    Math.sin(i / 20),
  );
  const expected = new PcmResampler(24000, 48000).process(samples);
  const stream = new PcmResampler(24000, 48000);
  const parts = [
    stream.process(samples.slice(0, 541)),
    stream.process(samples.slice(541)),
  ];
  assert.deepEqual(Float32Array.from([...parts[0], ...parts[1]]), expected);
  assert.ok(Math.abs(expected.length - 4800) <= 2);
  const queue = new VoiceOutputQueue(48000);
  queue.command("hold");
  queue.process(expected, new Float32Array(0));
  assert.deepEqual(
    queue.process(new Float32Array(0), new Float32Array(100)),
    new Float32Array(100),
  );
  queue.command("play");
  assert.deepEqual(
    queue.process(new Float32Array(0), new Float32Array(100)),
    expected.slice(0, 100),
  );
});
