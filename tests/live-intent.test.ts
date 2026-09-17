import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveIntent } from "../backend/src/live-intent.js";
import { createPlayerConfig } from "@aside/engine/player";
import type {
  LiveControlEvent,
  LivePlayerState,
  QuestionRequest,
  QuestionResult,
} from "@aside/engine/contracts";

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const state = (patch: Partial<LivePlayerState> = {}): LivePlayerState => ({
  version: 0,
  sequence: 0,
  revision: 1,
  positionMs: 31000,
  wasPlaying: true,
  audibleSource: "podcast",
  config: createPlayerConfig(),
  ...patch,
});
function setup(debug = false, limit = 30) {
  let now = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let next = 0;
  const requests: {
    data: QuestionRequest;
    signal: AbortSignal;
    resolve: (r: QuestionResult) => void;
    reject: (e: Error) => void;
  }[] = [];
  const events: LiveControlEvent[] = [];
  const notes: string[] = [];
  const intent = new LiveIntent(
    state(),
    [],
    {
      answer: (data, signal) =>
        new Promise((resolve, reject) =>
          requests.push({ data, signal, resolve, reject }),
        ),
      emit: (event) => events.push(event),
      context: (text) => notes.push(text),
      now: () => now,
      after: (delay, run) => {
        const id = next++;
        timers.set(id, { at: now + delay, run });
        return () => {
          timers.delete(id);
        };
      },
    },
    debug,
    limit,
  );
  const advance = async (ms = 200) => {
    now += ms;
    for (const [id, t] of [...timers])
      if (t.at <= now) {
        timers.delete(id);
        t.run();
      }
    await flush();
  };
  const speak = (delta: string, start_ms = now, end_ms = now + 100) =>
    intent.receive({
      type: "session.input_transcript.delta",
      delta,
      start_ms,
      end_ms,
    });
  const finish = async (
    action: QuestionResult["action"],
    index = requests.length - 1,
  ) => {
    const r = requests[index];
    r.resolve({
      action,
      revision: r.data.revision,
      answer: action === "answer" ? "A response" : "",
      sources: [],
      tools: [],
      ...(action === "player_control"
        ? { commandId: `command-${index}`, commands: [{ type: "pause" }] }
        : {}),
    } as QuestionResult);
    await flush();
  };
  return { intent, events, requests, speak, finish, advance, notes };
}

test("server classifies any transcript fragment without delegation, keywords or speech-end", async () => {
  const s = setup();
  s.speak("Could you lower that a bit?");
  await s.advance();
  assert.equal(s.requests.length, 1);
  assert.equal(
    s.requests[0].data.history.at(-1)?.text,
    "Could you lower that a bit?",
  );
  await s.finish("player_control");
  const result = s.events.find((e) => e.type === "decision");
  assert.equal(result?.type, "decision");
  assert.equal(result?.type === "decision" && result.player.positionMs, 31000);
  assert.equal(
    s.events.some((e) => "text" in e && e.type !== "decision"),
    false,
  );
  s.intent.close();
});

test("bystander ignore is silent and does not discard a later addressed clause", async () => {
  const s = setup(true);
  s.speak("Honey, what should we eat?");
  await s.advance();
  await s.finish("ignore");
  s.speak(" Aside, pause the podcast.");
  await s.advance();
  assert.equal(s.requests.length, 2);
  assert.match(s.requests[1].data.history.at(-1)!.text, /Aside, pause/);
  await s.finish("player_control");
  assert.deepEqual(
    s.events.filter((e) => e.type === "decision").map((e) => e.result.action),
    ["ignore", "player_control"],
  );
  s.intent.close();
});

test("partial changes use one in-flight model call and discard its stale action", async () => {
  const s = setup();
  s.speak("Stop");
  await s.advance();
  s.speak("—actually, don't stop.");
  await s.advance();
  assert.equal(s.requests.length, 1);
  await s.finish("player_control");
  await s.advance();
  assert.equal(
    s.events.some((e) => e.type === "decision"),
    false,
  );
  assert.equal(s.requests.length, 2);
  await s.finish("ignore");
  assert.equal(s.events.filter((e) => e.type === "decision").length, 1);
  s.intent.close();
});

test("an acknowledged action is not repeated by a late delegation or trailing politeness", async () => {
  const s = setup();
  s.speak("Slower");
  await s.advance();
  await s.finish("player_control");
  const decision = s.events.find((e) => e.type === "decision")!;
  assert.equal(decision.type, "decision");
  s.speak(" please");
  await s.advance();
  assert.equal(
    s.requests.length,
    1,
    "execution acknowledgement gates further actions",
  );
  s.intent.update(state({ sequence: 1, revision: 2 }), {
    decisionId: decision.decisionId,
    applied: true,
  });
  await s.advance();
  assert.equal(s.requests[1].data.player?.handledText, "Slower");
  await s.finish("ignore");
  s.intent.receive({
    type: "session.delegation.created",
    delegation: { id: "late", target: "client" },
  });
  await s.advance();
  assert.equal(s.requests.length, 2);
  assert.equal(s.notes.length, 1);
  s.intent.close();
});

test("manual state supersedes old work; old state and acknowledgements cannot restore it", async () => {
  const s = setup();
  s.speak("replay");
  await s.advance();
  s.intent.update(
    state({ version: 1, sequence: 2, revision: 5, positionMs: 70000 }),
  );
  assert.equal(s.requests[0].signal.aborted, true);
  s.intent.update(state({ sequence: 1 }));
  await s.finish("player_control");
  assert.equal(
    s.events.some((e) => e.type === "decision"),
    false,
  );
  s.speak("Pause", 3000, 3200);
  await s.advance();
  assert.equal(s.requests[1].data.player?.positionMs, 70000);
  s.intent.close();
});

test("wait stays open, whitespace stays intact, transcript events are deduplicated", async () => {
  const s = setup();
  s.speak("Could", 0, 100);
  s.speak("Could", 0, 100);
  s.speak(" ", 100, 110);
  await s.advance();
  await s.finish("wait");
  s.speak("you repeat?", 110, 200);
  await s.advance();
  assert.equal(s.requests[1].data.history.at(-1)?.text, "Could you repeat?");
  await s.finish("player_control");
  s.intent.close();
});

test("closing aborts work and a model failure is observable without a playback action", async () => {
  const s = setup();
  s.speak("Pause");
  await s.advance();
  s.requests[0].reject(Error("private provider error"));
  await flush();
  assert.deepEqual(s.events.at(-1), {
    type: "error",
    error:
      "Voice intent classification failed. Please reconnect the microphone.",
  });
  s.intent.close();
  s.intent.close();
  s.speak("play");
  await s.advance();
  assert.equal(s.requests.length, 1);
});

test("session work is bounded and no model call is created per audio frame", async () => {
  const s = setup(false, 1);
  s.intent.receive({ type: "session.input_audio.append", audio: "fake" });
  s.intent.receive({ type: "session.input_transcript.delta", delta: 12 });
  await s.advance();
  assert.equal(s.requests.length, 0);
  s.speak("Hi");
  await s.advance();
  await s.finish("wait");
  s.speak(" there");
  await s.advance();
  assert.equal(s.requests.length, 1);
  assert.equal(s.events.at(-1)?.type, "error");
  s.intent.close();
});

test("mixed control and question continues on the server only after playback acknowledgement", async () => {
  const s = setup();
  s.speak("Slow down and explain that"); await s.advance();
  const first = s.requests[0];
  first.resolve({ action: "player_control", revision: 1, commandId: "mixed", commands: [{ type: "adjust_rate", direction: "slower" }], followUpQuestion: "Explain that", answer: "", sources: [], tools: [] });
  await flush();
  const decision = s.events.find(e => e.type === "decision")!;
  s.intent.update(state({ sequence: 1 }), { decisionId: decision.decisionId, applied: true });
  await s.advance();
  assert.equal(s.requests.length, 2);
  assert.equal(s.requests[1].data.history.at(-1)?.text, "Explain that");
  await s.finish("answer");
  const answer = s.events.filter(e => e.type === "decision").at(-1)!;
  s.intent.update(state({ sequence: 2, revision: 2 }), { decisionId: answer.decisionId, applied: true });
  s.speak("What else?", 3000, 3100); await s.advance();
  assert.ok(s.requests[2].data.history.some(t => t.role === "assistant" && t.text === "A response"));
  s.intent.close();
});

test("rejected and missing acknowledgements never silently allow another command", async () => {
  const rejected = setup(); rejected.speak("Pause"); await rejected.advance(); await rejected.finish("player_control");
  const decision = rejected.events.find(e => e.type === "decision")!;
  rejected.intent.update(state({ sequence: 1 }), { decisionId: decision.decisionId, applied: false });
  await rejected.advance(); assert.equal(rejected.requests.length, 1);
  rejected.intent.close();
  const missing = setup(); missing.speak("Pause"); await missing.advance(); await missing.finish("player_control");
  await missing.advance(10000);
  assert.match((missing.events.at(-1) as { error: string }).error, /acknowledgement timed out/);
  missing.intent.close();
});
