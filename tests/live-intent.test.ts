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
import { liveControlEventSchema } from "@aside/engine/contracts";

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

test("input markers survive observation, classification and decision without debug text, and advance for the next utterance", async () => {
  const s = setup();
  s.speak("Why", 1000, 1100);
  s.speak(" Ah Q?", 1100, 1500);
  await s.advance();
  await s.finish("answer");
  const decision = s.events.find((e) => e.type === "decision")!;
  assert.equal(decision.type, "decision");
  const marker = { turnId: decision.player.turnId, startMs: 1000 };
  for (const event of s.events) {
    assert.ok(liveControlEventSchema.safeParse(event).success);
    if (
      event.type === "observing" ||
      event.type === "classifying" ||
      event.type === "decision"
    )
      assert.deepEqual(event.input, marker);
  }
  s.intent.update(
    state({
      sequence: 1,
      assistant: {
        decisionId: decision.decisionId,
        state: "speaking",
        text: "The explanation",
      },
    }),
    { decisionId: decision.decisionId, applied: true },
  );
  s.speak("Why that name?", 4000, 4500);
  const next = s.events.at(-1)!;
  assert.equal(next.type, "observing");
  assert.notEqual(next.input?.turnId, marker.turnId);
  assert.equal(next.input?.startMs, 4000);
  s.intent.close();
});

test("invalid supplier timestamps do not break the NDJSON contract", async () => {
  for (const time of [NaN, Infinity, -1]) {
    const s = setup();
    s.speak("Explain", time, time);
    await s.advance();
    await s.finish("answer");
    for (const event of s.events)
      assert.ok(liveControlEventSchema.safeParse(event).success);
    const observed = s.events.find((e) => e.type === "observing")!;
    assert.equal(observed.input?.startMs, undefined);
    s.intent.close();
  }
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

test("a stopped trial session tells the listener the session ended, not that classification broke", async () => {
  const s = setup();
  s.speak("Pause");
  await s.advance();
  s.requests[0].reject(Error("Trial stopped"));
  await flush();
  assert.deepEqual(s.events.at(-1), {
    type: "error",
    error: "Voice session ended. Please reconnect the microphone.",
  });
  s.intent.close();
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
  s.speak("Slow down and explain that");
  await s.advance();
  const first = s.requests[0];
  first.resolve({
    action: "player_control",
    revision: 1,
    commandId: "mixed",
    commands: [{ type: "adjust_rate", direction: "slower" }],
    followUpQuestion: "Explain that",
    answer: "",
    sources: [],
    tools: [],
  });
  await flush();
  const decision = s.events.find((e) => e.type === "decision")!;
  s.intent.update(state({ sequence: 1 }), {
    decisionId: decision.decisionId,
    applied: true,
  });
  await s.advance();
  assert.equal(s.requests.length, 2);
  assert.equal(s.requests[1].data.history.at(-1)?.text, "Explain that");
  await s.finish("answer");
  const answer = s.events.filter((e) => e.type === "decision").at(-1)!;
  s.intent.update(
    state({
      sequence: 2,
      revision: 2,
      assistant: {
        decisionId: answer.decisionId,
        text: "The delivered response",
        state: "finished",
      },
    }),
    {
      decisionId: answer.decisionId,
      applied: true,
    },
  );
  s.speak("What else?", 3000, 3100);
  await s.advance();
  assert.ok(
    s.requests[2].data.history.some(
      (t) => t.role === "assistant" && t.text === "The delivered response",
    ),
  );
  s.intent.close();
});

test("rejected and missing acknowledgements never silently allow another command", async () => {
  const rejected = setup();
  rejected.speak("Pause");
  await rejected.advance();
  await rejected.finish("player_control");
  const decision = rejected.events.find((e) => e.type === "decision")!;
  rejected.intent.update(state({ sequence: 1 }), {
    decisionId: decision.decisionId,
    applied: false,
  });
  await rejected.advance();
  assert.equal(rejected.requests.length, 1);
  rejected.intent.close();
  const missing = setup();
  missing.speak("Pause");
  await missing.advance();
  await missing.finish("player_control");
  await missing.advance(10000);
  assert.match(
    (missing.events.at(-1) as { error: string }).error,
    /acknowledgement timed out/,
  );
  missing.intent.close();
});

test("a short confirmation sees the spoken offer and tool state in the same conversation", async () => {
  const s = setup();
  s.speak("Could you continue?");
  await s.advance();
  await s.finish("answer");
  const answer = s.events.find((e) => e.type === "decision")!;
  s.intent.update(
    state({
      sequence: 1,
      wasPlaying: false,
      audibleSource: "none",
      playback: { mode: "awaiting_followup", interrupted: true },
    }),
    { decisionId: answer.decisionId, applied: true },
  );
  s.speak("Yes", 3000, 3100);
  await s.advance();
  assert.equal(s.requests.length, 2);
  // The output report arrives while this confirmation is being interpreted.
  s.intent.update(
    state({
      sequence: 2,
      wasPlaying: false,
      audibleSource: "none",
      assistant: {
        decisionId: answer.decisionId,
        text: "Shall I resume the podcast?",
        state: "finished",
      },
    }),
  );
  await s.finish("answer");
  await s.advance();
  assert.equal(
    s.events.filter((e) => e.type === "decision").length,
    1,
    "result based on missing dialogue context was discarded",
  );
  assert.deepEqual(s.requests[2].data.history.slice(-2), [
    { role: "assistant", text: "Shall I resume the podcast?" },
    { role: "user", text: "Yes" },
  ]);
  await s.finish("resume");
  const resume = s.events.filter((e) => e.type === "decision").at(-1)!;
  s.intent.update(
    state({ sequence: 3, playback: { mode: "resuming", interrupted: true } }),
    { decisionId: resume.decisionId, applied: true },
  );
  s.speak("Slower", 5000, 5100);
  await s.advance();
  assert.deepEqual(
    s.requests[3].data.conversation?.recentActions.at(-1)?.commands,
    [{ type: "play" }],
  );
  s.intent.close();
});

test("spoken replies do not re-submit an already handled question, and a quick yes is a new turn", async () => {
  const s = setup();
  s.speak("Continue?");
  await s.advance();
  await s.finish("answer");
  const answer = s.events.find((e) => e.type === "decision")!;
  s.intent.update(
    state({
      sequence: 1,
      assistant: {
        decisionId: answer.decisionId,
        text: "Resume?",
        state: "finished",
      },
    }),
    { decisionId: answer.decisionId, applied: true },
  );
  await s.advance();
  assert.equal(s.requests.length, 1);
  s.speak("Yes", 600, 700);
  await s.advance();
  assert.equal(s.requests[1].data.history.at(-1)?.text, "Yes");
  assert.equal(s.requests[1].data.player?.handledText, undefined);
  s.intent.close();
});

test("late punctuation cannot create a phantom question or interrupt a queued or spoken answer", async () => {
  const s = setup(true);
  s.speak('？"}', 0, 10);
  await s.advance();
  assert.equal(s.requests.length, 0);
  assert.equal(
    s.events.length,
    0,
    "non-speech fragments do not signal a new utterance",
  );
  s.speak("那为什么是正传呢", 100, 500);
  await s.advance();
  s.speak("？", 500, 510);
  await s.finish("answer");
  const answer = s.events.find((e) => e.type === "decision")!;
  assert.ok(
    answer,
    "trailing punctuation must not discard the in-flight answer",
  );
  s.speak('"}', 510, 520);
  const snapshot = (
    sequence: number,
    outputState: "queued" | "speaking" | "finished",
  ) =>
    state({
      sequence,
      wasPlaying: false,
      assistant: {
        decisionId: answer.decisionId,
        text: outputState === "queued" ? "" : "因为这些名目都不合",
        state: outputState,
      },
    });
  s.intent.update(snapshot(1, "queued"), {
    decisionId: answer.decisionId,
    applied: true,
  });
  s.speak("？", 520, 530);
  s.intent.update(snapshot(2, "speaking"));
  s.speak('"}', 530, 540);
  s.intent.update(snapshot(3, "finished"));
  s.speak("。", 540, 550);
  await s.advance();
  assert.equal(
    s.requests.length,
    1,
    "no punctuation-only follow-up reaches the model",
  );
  assert.equal(s.events.filter((e) => e.type === "observing").length, 1);
  s.speak("你继续播放吧", 700, 900);
  await s.advance();
  assert.equal(s.requests.at(-1)?.data.history.at(-1)?.text, "你继续播放吧");
  s.intent.close();
});

test("separate spaces and numeric punctuation remain between meaningful transcript fragments", async () => {
  const s = setup();
  s.speak("Set");
  s.speak(" ", 100, 110);
  s.speak("rate to 0", 110, 200);
  s.speak(".", 200, 210);
  s.speak("5", 210, 300);
  await s.advance();
  assert.equal(s.requests[0].data.history.at(-1)?.text, "Set rate to 0.5");
  s.intent.close();
});

test("streaming assistant updates cannot indefinitely postpone an interruption or reclassify bystanders", async () => {
  for (const result of ["player_control", "ignore"] as const) {
    const s = setup();
    s.speak("Explain that");
    await s.advance();
    await s.finish("answer");
    const answer = s.events.find((e) => e.type === "decision")!;
    const output = (sequence: number) =>
      state({
        sequence,
        wasPlaying: false,
        audibleSource: "assistant",
        assistant: {
          decisionId: answer.decisionId,
          state: "speaking",
          text: "An ongoing explanation. ".repeat(sequence),
        },
      });
    s.intent.update(output(1), {
      decisionId: answer.decisionId,
      applied: true,
    });
    s.speak(
      result === "ignore" ? "Honey, what's for dinner?" : "Stop",
      600,
      700,
    );
    await s.advance();
    s.intent.update(output(2));
    await s.finish(result);
    await s.advance();
    assert.equal(s.requests.length, 3, "one refresh includes the new context");
    s.intent.update(output(3));
    await s.finish(result);
    assert.equal(
      s.events.filter((e) => e.type === "decision").at(-1)?.result.action,
      result,
      "continued assistant speech cannot starve the user decision",
    );
    s.intent.update(output(4));
    await s.advance();
    assert.equal(s.requests.length, 3, "unchanged input refresh is bounded");
    s.intent.close();
  }
});
