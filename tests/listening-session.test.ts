import { pendingDecisionMs } from "../player-runtime/src/conversation";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ListeningSession,
  type ListeningMode,
  type VoicePort,
} from "../frontend/src/listening-session.js";
import {
  attention,
  type SessionOptions,
} from "@aside/player-runtime/listening-session";
import type { RuntimeClock } from "../frontend/src/runtime-clock.js";
import type { VoiceCallbacks } from "@aside/player-runtime/ports";
import type { PlayerBackend } from "../frontend/src/player-api.js";
import type {
  QuestionRequest,
  QuestionResult,
  QuestionPhase,
  LivePlayerState,
  LiveControlEvent,
  LiveControlUpdate,
} from "@aside/engine/contracts";
import type { Episode } from "@aside/engine/core";
import { createPlayerConfig, type PlayerConfig } from "@aside/engine/player";
class Clock implements RuntimeClock {
  private time = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  private next = 0;
  now() {
    return this.time;
  }
  after(delay: number, callback: () => void) {
    const id = this.next++;
    this.timers.set(id, { at: this.time + delay, callback });
    return () => {
      this.timers.delete(id);
    };
  }
  advance(ms: number) {
    const end = this.time + ms;
    while (true) {
      const next = [...this.timers]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.time = end;
  }
}
// Drain promise chains completely; adding a native timeout adapter must not
// change how far a fixture thinks a serialized acknowledgement progressed.
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const episode: Episode = {
  id: "test",
  title: "播客",
  durationMs: 90000,
  createdAt: "now",
  status: "ready",
  stage: "ready",
  progress: 1,
  analysis: {
    version: "1",
    source: "demo",
    summary: "",
    hostStyle: "",
    speakers: [],
    voice: "feminine",
    voiceReason: "test",
    passages: [
      {
        id: "heard",
        startMs: 1000,
        endMs: 2000,
        text: "已听原文",
        speaker: "host",
      },
      {
        id: "future",
        startMs: 40000,
        endMs: 50000,
        text: "未听原文",
        speaker: "host",
      },
    ],
    anchors: [
      {
        id: "anchor",
        startMs: 20000,
        endMs: 40000,
        text: "自然断点",
        confidence: 1,
      },
    ],
  },
};
function setup(
  mode: ListeningMode = "off",
  permission?: Promise<void>,
  playerConfig?: Partial<PlayerConfig>,
  debugRecognition = false,
  server = false,
  spokenResume: "quiet" | "verified" = "quiet",
  options: Pick<SessionOptions, "speechYield" | "followupMs"> = {},
) {
  const clock = new Clock();
  const audio = {
    positionMs: 31000,
    playing: false,
    plays: 0,
    async play() {
      this.playing = true;
      this.plays++;
    },
    pause() {
      this.playing = false;
    },
    level: 1,
    ducks: [] as number[],
    settles: 0,
    duck(level: number) {
      this.level = level;
      this.ducks.push(level);
    },
    async settle() {
      this.settles++;
      this.level = 1;
      this.playing = false;
    },
    config: createPlayerConfig(),
    configure(config: PlayerConfig) {
      this.config = config;
    },
  };
  const requests: {
    data: QuestionRequest;
    signal: AbortSignal;
    progress: (phase: QuestionPhase) => void;
    preview?: (text: string) => void;
    resolve: (result: QuestionResult) => void;
  }[] = [];
  const commands: string[] = [];
  let callbacks!: VoiceCallbacks;
  let enabled = false,
    captures = 0,
    warm = false,
    cold = true;
  let voiceCount = 0;
  let serverState!: LivePlayerState;
  let receive!: (event: LiveControlEvent) => void;
  let failControl!: (error: Error) => void;
  let createLive: (() => Promise<unknown>) | undefined;
  const updates: LiveControlUpdate[] = [];
  const liveRequests: Parameters<PlayerBackend["live"]>[1][] = [];
  const usages: Parameters<PlayerBackend["usage"]>[1][] = [];
  const usageEpisodes: string[] = [];
  let liveGate: Promise<void> | undefined;
  const backend: PlayerBackend = {
    question(_id, data, signal, progress, preview) {
      return new Promise((resolve) =>
        requests.push({ data, signal, progress, preview, resolve }),
      );
    },
    async live(_id, request) {
      if (!server) throw Error("Unexpected live negotiation");
      liveRequests.push(request);
      await liveGate;
      serverState = request.control!.player;
      return {
        session: { id: "test-session" },
        transport: { sdp: "mock" },
        control: true,
      };
    },
    ...(server
      ? {
          control: async (
            _id: string,
            _session: string,
            signal: AbortSignal,
            callback: (event: LiveControlEvent) => void,
          ) => {
            receive = callback;
            callback({ type: "ready", sessionId: "test-session" });
            await new Promise<void>((resolve, reject) => {
              failControl = reject;
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
          },
          updateControl: async (_id: string, data: LiveControlUpdate) => {
            serverState = data.player;
            updates.push(data);
          },
        }
      : {}),
    async transcribe() {
      throw Error("Unexpected transcription");
    },
    async usage(id, data) {
      usageEpisodes.push(id);
      usages.push(data);
    },
  };
  const voice: VoicePort = {
    get isEnabled() {
      return enabled;
    },
    get isWarm() {
      return warm;
    },
    get isCold() {
      return cold;
    },
    async enable() {
      enabled = true;
      callbacks.onStatus("arming");
      if (permission) await permission;
      if (enabled) callbacks.onStatus("armed");
      if (server && enabled) {
        await createLive!();
        warm = true;
        cold = false;
        callbacks.onReady();
      }
    },
    beginManual() {
      captures++;
      callbacks.onSpeech(true);
      return true;
    },
    endManual() {
      callbacks.onSpeech(false);
    },
    async close() {
      enabled = false;
      callbacks.onStatus("off");
    },
    cancelCapture() {
      commands.push("cancelCapture");
    },
    mute(value) {
      commands.push(`mute:${value}`);
    },
    prepareOutput() {
      commands.push("prepareOutput");
    },
    discardPendingOutput() {
      commands.push("discardPendingOutput");
    },
    interrupt() {
      commands.push("interrupt");
    },
    playbackResumed() {
      commands.push("resumed");
    },
    append(type, content) {
      commands.push(`${type}:${content}`);
    },
    activity() {},
    setWorking(value) {
      commands.push(`working:${value}`);
    },
  };
  const session = new ListeningSession(audio, backend, {
    debugRecognition,
    mode,
    playerConfig,
    clock,
    spokenResume,
    ...options,
    voiceFactory(_mic, _config, cb, remote) {
      createLive = () => remote.create("mock");
      voiceCount++;
      callbacks = cb;
      return voice;
    },
  });
  session.configure({
    liveConfigured: true,
    microphone: { threshold: 0.025, minSpeechMs: 120, silenceMs: 650 },
    voiceLifecycle: {
      preRollMs: 750,
      graceMs: 5000,
      idleCloseMs: 60000,
      autoResumeMs: 3000,
    },
  });
  session.load(episode, { positionMs: 31000, history: [] });
  session.metadataLoaded();
  audio.positionMs = 31000;
  return {
    clock,
    audio,
    session,
    requests,
    commands,
    updates,
    liveRequests,
    failControl(
      message = "Voice session time limit reached. Please reconnect the microphone.",
    ) {
      failControl(Error(message));
    },
    push(event: LiveControlEvent) {
      receive(event);
    },
    decision(
      action: QuestionResult["action"],
      commands: import("@aside/engine/player").PlayerCommand[] = [
        { type: "pause" },
      ],
    ) {
      const event: Extract<LiveControlEvent, { type: "decision" }> = {
        type: "decision",
        version: serverState.version,
        decisionId: crypto.randomUUID(),
        text: "A spoken request",
        player: { ...serverState, source: "voice", turnId: "server-turn" },
        result: {
          action,
          revision: serverState.revision,
          answer: "An answer",
          sources: [],
          tools: [],
          ...(action === "player_control"
            ? { commandId: crypto.randomUUID(), commands }
            : {}),
        } as QuestionResult,
      };
      return event;
    },
    usages,
    usageEpisodes,
    /** Keeps the next session start pending until the returned release runs. */
    holdLive() {
      let release!: () => void;
      liveGate = new Promise<void>((resolve) => (release = resolve));
      return release;
    },
    get serverState() {
      return serverState;
    },
    get callbacks() {
      return callbacks;
    },
    get captures() {
      return captures;
    },
    get enabled() {
      return enabled;
    },
    get voiceCount() {
      return voiceCount;
    },
    warm() {
      warm = true;
      cold = false;
    },
    answer(index: number, text = "简短回答") {
      requests[index].resolve({
        revision: requests[index].data.revision,
        action: "answer",
        answer: text,
        sources: [],
        tools: [],
      });
    },
  };
}

test("mobile delegates live context to the server across transcript gaps and player actions", async (t) => {
  const s = setup(
    "auto",
    undefined,
    undefined,
    false,
    true,
    "verified",
  );
  t.after(() => s.session.dispose());
  s.session.start();
  await flush();
  // Reproduce native status callbacks in a gap between transcript passages.
  // Previously undefined was compared with the stored -1 sentinel, appending
  // the same programme text to GPT-Live on every 250 ms tick during speech.
  for (let i = 0; i < 20; i++) {
    s.audio.positionMs += 250;
    s.clock.advance(250);
    s.session.audioTick();
    await flush();
  }
  s.session.seek(42000);
  await flush();
  assert.deepEqual(
    s.commands.filter((c) => c.startsWith("thinking:")),
    [],
  );
  assert.ok(
    s.updates.length >= 5,
    "backend still receives the moving playhead",
  );
  assert.equal(s.serverState.positionMs, 42000);
  assert.equal(s.serverState.wasPlaying, false);
  await s.session.dispose();
});

test("client context remains available for non-server automatic and manual questions", async (t) => {
  for (const mode of ["auto", "manual"] as const) {
    const s = setup(
      mode,
      undefined,
      undefined,
      false,
      mode === "manual",
      "verified",
    );
    t.after(() => s.session.dispose());
    s.session.start();
    if (mode === "manual") await s.session.beginManual();
    await flush();
    s.callbacks.onReady();
    assert.ok(
      s.commands.some(
        (c) => c.startsWith("thinking:") && c.includes("已听原文"),
      ),
    );
    await s.session.dispose();
  }
});

test("loading a checkpoint publishes only its complete state to persistence subscribers", () => {
  const s = setup();
  s.session.start();
  const observed: ReturnType<typeof s.session.checkpoint>[] = [];
  s.session.subscribe(() => observed.push(s.session.checkpoint()));
  const history = [
    { role: "user" as const, text: "Restored question" },
    { role: "assistant" as const, text: "Restored answer" },
  ];
  s.session.load({ ...episode, id: "another" }, { positionMs: 5000, history });
  assert.equal(observed.length, 1);
  assert.equal(observed[0].positionMs, 5000);
  assert.deepEqual(observed[0].history, history);
});

test("recognition diagnostics are opt-in and never turn raw deltas into a question", async () => {
  const s = setup("auto");
  s.session.start();
  await flush();
  s.callbacks.onInputTranscript?.("Private background speech");
  assert.equal((await s.session.voiceDiagnostics()).recognition, undefined);
  assert.equal(s.requests.length, 0);
  assert.deepEqual(s.session.checkpoint().history, []);
  s.session.dispose();
});

test("debug recognition preserves raw fragments and distinguishes backend dispatch", async () => {
  const s = setup("auto", undefined, undefined, true);
  s.session.start();
  await flush();
  s.warm();
  s.callbacks.onInputTranscript?.("Wait, wait!");
  let trace = (await s.session.voiceDiagnostics()).recognition!;
  assert.equal(trace.liveInputText, "Wait, wait!");
  assert.equal(trace.conversationInput, "");
  assert.equal(trace.submittedText, "");
  s.callbacks.onTranscript("user", "Wait, wait!");
  s.callbacks.onDelegation("debug-manual");
  s.clock.advance(120);
  await flush();
  trace = (await s.session.voiceDiagnostics()).recognition!;
  assert.equal(trace.conversationInput, "Wait, wait!");
  assert.equal(trace.submittedText, s.requests[0].data.history.at(-1)?.text);
  assert.equal(trace.requestPending, true);
  assert.deepEqual(s.session.checkpoint().history, []);
  assert.ok(
    s.session
      .getSnapshot()
      .events.every((event) => !event.includes("Wait, wait!")),
  );
  s.session.stop();
  assert.equal(
    (await s.session.voiceDiagnostics()).recognition?.liveInputText,
    "Wait, wait!",
  );
  s.session.dispose();
});

test("debug recognition is bounded, preserves whitespace and clears on a new connection or episode", async () => {
  const s = setup("auto", undefined, undefined, true);
  s.session.start();
  await flush();
  for (const text of ["Hello", " ", "there!"])
    s.callbacks.onInputTranscript?.(text);
  assert.equal(
    (await s.session.voiceDiagnostics()).recognition?.liveInputText,
    "Hello there!",
  );
  for (let i = 0; i < 40; i++) s.callbacks.onInputTranscript?.("x".repeat(600));
  const trace = (await s.session.voiceDiagnostics()).recognition!;
  assert.equal(trace.liveInputText.length, 4000);
  assert.equal(trace.recentDeltas.length, 30);
  assert.ok(trace.recentDeltas.every((delta) => delta.text.length === 500));
  const old = s.callbacks;
  s.session.stop();
  old.onInputTranscript?.("stale");
  assert.equal(
    (await s.session.voiceDiagnostics()).recognition?.liveInputText,
    trace.liveInputText,
  );
  s.session.start();
  await flush();
  assert.equal(
    (await s.session.voiceDiagnostics()).recognition?.liveInputText,
    "",
  );
  s.callbacks.onInputTranscript?.("new episode must not inherit this");
  s.session.load(episode, null);
  assert.equal(
    (await s.session.voiceDiagnostics()).recognition?.liveInputText,
    "",
  );
  s.session.dispose();
});

test("complete text action cancels older work and resumes at the fixed semantic anchor", async () => {
  const s = setup();
  s.session.start();
  s.session.submitQuestion("第一个问题");
  assert.equal(s.audio.playing, false);
  assert.equal(s.session.getSnapshot().state.interruption?.resumeMs, 20000);
  s.session.submitQuestion("新问题");
  assert.equal(s.requests[0].signal.aborted, true);
  s.answer(0, "过期答案");
  await flush();
  assert.equal(
    s.session.getSnapshot().history.some((turn) => turn.text === "过期答案"),
    false,
  );
  s.answer(1);
  await flush();
  assert.equal(s.session.getSnapshot().resumeSeconds, 3);
  s.clock.advance(2999);
  assert.equal(s.audio.playing, false);
  s.clock.advance(1);
  await flush();
  assert.equal(s.audio.playing, true);
  assert.equal(s.audio.positionMs, 20000);
  assert.equal(s.voiceCount, 0);
  s.session.dispose();
});
test("hold persists across follow-ups, while seek clears the interruption and pending work", async () => {
  const s = setup();
  s.session.start();
  s.session.submitQuestion("为什么");
  s.answer(0);
  await flush();
  s.session.holdResume();
  s.session.submitQuestion("多解释一点");
  s.answer(1);
  await flush();
  s.clock.advance(61000);
  await flush();
  assert.equal(s.audio.playing, false);
  assert.equal(s.session.getSnapshot().resumeHeld, true);
  assert.equal(s.session.getSnapshot().returnContext, "已听原文");
  s.session.submitQuestion("旧位置的问题");
  s.session.seek(65000);
  assert.equal(s.requests[2].signal.aborted, true);
  s.answer(2, "错误位置的回答");
  await flush();
  assert.equal(s.session.getSnapshot().state.interruption, undefined);
  assert.equal(s.session.getSnapshot().resumeHeld, false);
  assert.equal(s.audio.positionMs, 65000);
  assert.equal(
    s.session
      .getSnapshot()
      .history.some((turn) => turn.text === "错误位置的回答"),
    false,
  );
  s.session.dispose();
});
test("manual permission resolving after release or mode change cannot begin capture", async () => {
  for (const action of ["release", "switch"] as const) {
    let grant!: () => void;
    const s = setup(
      "manual",
      new Promise<void>((resolve) => {
        grant = resolve;
      }),
    );
    const pending = s.session.beginManual();
    if (action === "release") s.session.endManual();
    else s.session.setListeningMode("off");
    grant();
    await pending;
    await flush();
    assert.equal(s.captures, 0);
    assert.equal(s.enabled, false);
    assert.equal(s.session.getSnapshot().manualHeld, false);
    s.session.dispose();
  }
});
test("voice progress is excluded from latency and the countdown starts after the answer audio", async () => {
  const s = setup("auto");
  s.session.start();
  await flush();
  s.callbacks.onSpeech(true);
  s.callbacks.onSpeech(false);
  s.callbacks.onFirstQuestion("为什么");
  s.requests[0].progress("working");
  s.clock.advance(1500);
  s.callbacks.onOutput(true);
  s.callbacks.onOutput(false);
  assert.equal(s.session.getSnapshot().latencies.length, 0);
  assert.equal(s.session.getSnapshot().resumeSeconds, null);
  s.answer(0);
  await flush();
  s.clock.advance(1000);
  assert.equal(s.session.getSnapshot().resumeSeconds, null);
  s.callbacks.onOutput(true);
  assert.deepEqual(s.session.getSnapshot().latencies, [
    { connection: "cold", milliseconds: 2500 },
  ]);
  s.clock.advance(1000);
  s.callbacks.onOutput(false);
  assert.equal(s.session.getSnapshot().resumeSeconds, 3);
  s.clock.advance(3000);
  await flush();
  assert.equal(s.audio.playing, true, "three quiet seconds resume the podcast");
  s.session.dispose();
});
test("warm transcript and delegation cancel countdown, then resume survives cloud failure", async () => {
  const s = setup("auto");
  s.session.start();
  await flush();
  s.callbacks.onSpeech(true);
  s.callbacks.onSpeech(false);
  s.callbacks.onFirstQuestion("为什么");
  s.answer(0);
  await flush();
  s.callbacks.onOutput(true);
  s.callbacks.onOutput(false);
  s.warm();
  s.callbacks.onSpeech(true);
  s.callbacks.onTranscript("user", "再解释");
  s.callbacks.onDelegation("follow-up");
  s.callbacks.onSpeech(false);
  s.clock.advance(450);
  assert.equal(s.requests.length, 2);
  assert.equal(s.session.getSnapshot().resumeSeconds, null);
  s.answer(1);
  await flush();
  s.callbacks.onOutput(true);
  s.callbacks.onOutput(false);
  s.callbacks.onSpeech(true);
  s.callbacks.onTranscript("user", "继续");
  s.callbacks.onDelegation("resume-request");
  s.callbacks.onSpeech(false);
  s.clock.advance(450);
  s.requests[2].resolve({
    revision: s.requests[2].data.revision,
    action: "resume",
    answer: "",
    sources: [],
    tools: [],
  });
  await flush();
  assert.equal(s.session.getSnapshot().state.mode, "resuming");
  s.callbacks.onError("connection failed");
  s.callbacks.onClose(false, 1, "s", false);
  s.callbacks.onTranscript("assistant", "过期字幕");
  s.callbacks.onDelegation("stale");
  s.clock.advance(1499);
  assert.equal(s.audio.playing, false);
  s.clock.advance(1);
  await flush();
  assert.equal(s.audio.playing, true);
  assert.equal(s.requests.length, 3);
  assert.equal(
    s.session
      .getSnapshot()
      .history.some((turn) => turn.text.includes("过期字幕")),
    false,
  );
  s.session.dispose();
});
test("a late failure from an old play promise cannot stop a newer manual recording", async () => {
  const s = setup("manual");
  let reject!: (error: Error) => void;
  s.audio.play = () =>
    new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
  s.session.start();
  const recording = s.session.beginManual();
  reject(new Error("play interrupted"));
  await recording;
  await flush();
  assert.equal(s.captures, 1);
  assert.equal(s.session.getSnapshot().manualHeld, true);
  assert.equal(s.session.getSnapshot().error, "");
  s.session.dispose();
});

test("recognized manual speech is visible and saved before Live or the answer is ready", async () => {
  const s = setup("manual");
  s.session.start();
  await s.session.beginManual();
  s.session.endManual();
  const saved: string[][] = [];
  s.session.subscribe(() =>
    saved.push(s.session.checkpoint().history.map((t) => t.text)),
  );
  s.callbacks.onQuestionRecognized?.("Why did the speaker say that?");
  assert.deepEqual(
    s.session.getSnapshot().history.map((t) => t.text),
    ["Why did the speaker say that?"],
  );
  assert.deepEqual(saved.at(-1), ["Why did the speaker say that?"]);
  assert.equal(
    s.requests.length,
    0,
    "recognition must not submit before Live is ready",
  );
  s.callbacks.onFirstQuestion("Why did the speaker say that?");
  assert.equal(s.requests.length, 1);
  assert.equal(
    s.session.getSnapshot().history.length,
    1,
    "ready callback must not duplicate the question",
  );
  assert.equal(s.session.getSnapshot().busy, true);
  s.session.background();
  assert.equal(s.requests[0].signal.aborted, true);
  const checkpoint = s.session.checkpoint();
  s.session.load(episode, checkpoint);
  assert.deepEqual(
    s.session.getSnapshot().history.map((t) => t.text),
    ["Why did the speaker say that?"],
  );
  s.session.dispose();
});

test("a failed Live connection keeps already recognized speech without submitting another question", async () => {
  const s = setup("manual");
  await s.session.beginManual();
  s.session.endManual();
  s.callbacks.onQuestionRecognized?.("Please explain this part");
  s.callbacks.onError("Connection timed out");
  assert.deepEqual(
    s.session.getSnapshot().history.map((t) => t.text),
    ["Please explain this part"],
  );
  assert.deepEqual(
    s.session.checkpoint().history,
    s.session.getSnapshot().history,
  );
  assert.equal(s.requests.length, 0);
  s.session.dispose();
});

test("resuming during a spoken answer preserves the submitted question but discards incomplete assistant output", async () => {
  const s = setup("manual");
  s.session.start();
  await s.session.beginManual();
  s.session.endManual();
  s.callbacks.onFirstQuestion("Explain the interview");
  s.answer(0);
  await flush();
  s.callbacks.onOutput(true);
  s.callbacks.onTranscript("assistant", "An unfinished answer");
  s.session.start();
  assert.deepEqual(
    s.session.getSnapshot().history.map((t) => t.text),
    ["Explain the interview"],
  );
  assert.deepEqual(
    s.session.checkpoint().history,
    s.session.getSnapshot().history,
  );
  s.session.dispose();
});

test("a manual follow-up keeps the previous question while cancelling its pending answer", async () => {
  const s = setup("manual");
  await s.session.beginManual();
  s.session.endManual();
  s.callbacks.onFirstQuestion("First spoken question");
  await s.session.beginManual();
  s.session.endManual();
  s.callbacks.onFirstQuestion("Follow-up question");
  assert.equal(s.requests[0].signal.aborted, true);
  assert.deepEqual(
    s.requests[1].data.history.map((t) => t.text),
    ["First spoken question", "Follow-up question"],
  );
  s.answer(0, "Stale answer");
  await flush();
  assert.deepEqual(
    s.session.checkpoint().history.map((t) => t.text),
    ["First spoken question", "Follow-up question"],
  );
  s.session.dispose();
});

test("classification cannot erase an explicitly submitted manual message", async () => {
  for (const action of ["ignore", "wait"] as const) {
    const s = setup("manual");
    await s.session.beginManual();
    s.session.endManual();
    s.callbacks.onFirstQuestion("An explicitly submitted thought");
    s.requests[0].resolve({
      action,
      revision: s.requests[0].data.revision,
      answer: "",
      sources: [],
      tools: [],
    });
    await flush();
    assert.deepEqual(
      s.session.getSnapshot().history.map((t) => t.text),
      ["An explicitly submitted thought"],
    );
    assert.deepEqual(
      s.session.checkpoint().history,
      s.session.getSnapshot().history,
    );
    s.session.dispose();
  }
});

test("background keeps native podcast playback and the submitted question while cancelling its answer", async () => {
  const s = setup("manual");
  s.session.start();
  await flush();
  s.session.background();
  assert.equal(s.audio.playing, true);
  s.session.submitQuestion("An unfinished question");
  assert.equal(s.requests.length, 1);
  s.session.background();
  assert.equal(s.audio.playing, false);
  assert.equal(s.requests[0].signal.aborted, true);
  assert.deepEqual(
    s.session.checkpoint().history.map((t) => t.text),
    ["An unfinished question"],
  );
  assert.equal(s.session.checkpoint().resumeMs, 20000);
  s.clock.advance(60000);
  await flush();
  assert.equal(s.audio.playing, false);
  s.session.dispose();
});

test("a native asynchronous seek finishes before resumption starts the player", async () => {
  const s = setup();
  let finish!: () => void;
  Object.assign(s.audio, {
    seek: (positionMs: number) =>
      new Promise<void>((resolve) => {
        finish = () => {
          s.audio.positionMs = positionMs;
          resolve();
        };
      }),
  });
  s.session.seek(45000);
  s.session.start();
  await flush();
  assert.equal(s.audio.playing, false);
  finish();
  await flush();
  assert.equal(s.audio.playing, true);
  assert.equal(s.audio.positionMs, 45000);
  s.session.dispose();
});

test("native loaded status cannot erase a restored checkpoint before metadata seeking", async () => {
  const s = setup();
  let finish!: () => void;
  Object.assign(s.audio, {
    seek: (positionMs: number) =>
      new Promise<void>((resolve) => {
        finish = () => {
          s.audio.positionMs = positionMs;
          resolve();
        };
      }),
  });
  s.audio.positionMs = 0;
  s.session.load(episode, { positionMs: 16000, history: [] });
  // Native App's persistent status listener runs before its metadata listener.
  s.session.audioTick();
  assert.equal(s.session.checkpoint().positionMs, 16000);
  s.session.metadataLoaded();
  s.session.audioTick();
  assert.equal(s.session.checkpoint().positionMs, 16000);
  finish();
  await flush();
  s.session.audioTick();
  assert.equal(s.audio.positionMs, 16000);
  assert.equal(s.session.checkpoint().positionMs, 16000);
  s.audio.positionMs = 17000;
  s.session.audioTick();
  assert.equal(s.session.checkpoint().positionMs, 17000);
  s.session.dispose();
});

test("play waits for restored media, and pause cancels a pending start", async () => {
  const s = setup();
  let finish!: () => void;
  Object.assign(s.audio, {
    seek: (positionMs: number) =>
      new Promise<void>((resolve) => {
        finish = () => {
          s.audio.positionMs = positionMs;
          resolve();
        };
      }),
  });
  s.audio.positionMs = 0;
  s.session.load(episode, { positionMs: 16000, history: [] });
  s.session.start();
  await flush();
  assert.equal(s.audio.playing, false);
  s.session.metadataLoaded();
  s.session.stop();
  finish();
  await flush();
  assert.equal(s.audio.playing, false);
  assert.equal(s.audio.positionMs, 16000);
  s.session.start();
  await flush();
  assert.equal(s.audio.playing, true);
  s.session.dispose();
});

test("completion from a previous media load cannot unlock the next checkpoint", async () => {
  const s = setup();
  const finishes: (() => void)[] = [];
  Object.assign(s.audio, {
    seek: (positionMs: number) =>
      new Promise<void>((resolve) => {
        finishes.push(() => {
          s.audio.positionMs = positionMs;
          resolve();
        });
      }),
  });
  s.session.load(episode, { positionMs: 16000, history: [] });
  s.session.metadataLoaded();
  s.session.load(
    { ...episode, id: "next" },
    { positionMs: 42000, history: [] },
  );
  finishes[0]();
  await flush();
  s.session.audioTick();
  assert.equal(s.session.checkpoint().positionMs, 42000);
  s.session.start();
  assert.equal(s.audio.playing, false);
  s.session.metadataLoaded();
  finishes[1]();
  await flush();
  assert.equal(s.audio.positionMs, 42000);
  assert.equal(s.audio.playing, true);
  s.session.dispose();
});

test("an unavailable media load times out without erasing the checkpoint or starting late", async () => {
  const s = setup();
  s.audio.positionMs = 0;
  s.session.load(episode, { positionMs: 16000, history: [] });
  s.session.start();
  s.clock.advance(30000);
  assert.equal(s.session.getSnapshot().state.mode, "paused");
  assert.match(s.session.getSnapshot().error, /loading timed out/);
  assert.equal(s.session.checkpoint().positionMs, 16000);
  s.session.metadataLoaded();
  await flush();
  assert.equal(s.audio.playing, false);
  s.session.dispose();
});

test("player configuration applies immediately, survives episode changes and stays in the snapshot", () => {
  const s = setup("off", undefined, { playbackRate: 0.8, volume: 0.4 });
  assert.equal(s.audio.config.playbackRate, 0.8);
  s.session.executePlayerCommand({ type: "adjust_rate", direction: "slower" });
  assert.equal(s.audio.config.playbackRate, 0.7);
  assert.equal(s.session.getSnapshot().playerConfig.playbackRate, 0.7);
  s.session.setPlaybackRate(1.25);
  s.session.executePlayerCommand({ type: "set_muted", muted: true });
  s.session.load({ ...episode, id: "another" }, null);
  s.session.metadataLoaded();
  assert.equal(s.audio.config.playbackRate, 1.25);
  assert.equal(s.audio.config.volume, 0.4);
  assert.equal(s.audio.config.muted, true);
  assert.equal(s.audio.positionMs, 0);
  const before = s.session.getSnapshot().playerConfig;
  assert.throws(() => s.session.configurePlayer({ playbackRate: NaN }));
  assert.equal(s.session.getSnapshot().playerConfig, before);
  assert.equal(s.audio.config, before);
  s.session.dispose();
});

test("remote pause preserves local listening and exact position, while stop ends listening", async () => {
  const s = setup("auto");
  s.session.start();
  await flush();
  s.session.executePlayerCommand({ type: "pause" });
  assert.equal(s.audio.playing, false);
  assert.equal(s.session.getSnapshot().state.mode, "paused");
  assert.equal(s.enabled, true);
  assert.equal(s.session.getSnapshot().listeningActive, true);
  s.session.executePlayerCommand({ type: "play" });
  await flush();
  assert.equal(s.audio.playing, true);
  assert.equal(s.audio.positionMs, 31000);
  s.session.executePlayerCommand({ type: "stop" });
  assert.equal(s.audio.playing, false);
  assert.equal(s.enabled, false);
  assert.equal(s.session.getSnapshot().listeningActive, false);
  s.session.dispose();
});

test("skip preserves playback, explicit seek can pause, and bounds use the loaded episode", async () => {
  const s = setup();
  s.session.configurePlayer({ seekStepMs: 5000 });
  s.session.start();
  s.session.executePlayerCommand({ type: "skip", direction: "backward" });
  await flush();
  assert.equal(s.audio.positionMs, 26000);
  assert.equal(s.audio.playing, true);
  s.session.executePlayerCommand({
    type: "seek",
    atMs: 40000,
    playback: "pause",
  });
  assert.equal(s.audio.playing, false);
  s.session.executePlayerCommand({ type: "skip", direction: "forward" });
  assert.equal(s.audio.positionMs, 45000);
  assert.equal(s.audio.playing, false);
  s.session.seek(999999);
  assert.equal(s.audio.positionMs, 90000);
  s.session.seek(-100);
  assert.equal(s.audio.positionMs, 0);
  s.session.dispose();
});

test("repeat cancels pending answers and stale output, then plays from the semantic anchor", async () => {
  const s = setup("auto");
  s.session.start();
  await flush();
  s.session.submitQuestion("pending question");
  s.session.executePlayerCommand({ type: "repeat" });
  assert.equal(s.requests[0].signal.aborted, true);
  s.answer(0, "obsolete answer");
  s.callbacks.onOutput(true);
  s.callbacks.onTranscript("assistant", "obsolete transcript");
  await flush();
  assert.equal(s.audio.positionMs, 20000);
  assert.equal(s.audio.playing, true);
  assert.equal(s.session.getSnapshot().state.interruption, undefined);
  assert.equal(
    s.session.getSnapshot().history.some((t) => t.text.includes("obsolete")),
    false,
  );
  s.clock.advance(10000);
  assert.equal(s.audio.positionMs, 20000);
  s.session.dispose();
});

test("remote pause cancels follow-up countdown and does not resume at an old anchor", async () => {
  const s = setup();
  s.session.start();
  s.session.submitQuestion("question");
  s.answer(0);
  await flush();
  assert.equal(s.session.getSnapshot().resumeSeconds, 3);
  s.session.executePlayerCommand({ type: "pause" });
  s.clock.advance(10000);
  assert.equal(s.audio.playing, false);
  assert.equal(s.session.getSnapshot().resumeSeconds, null);
  s.session.executePlayerCommand({ type: "play" });
  await flush();
  assert.equal(s.audio.positionMs, 31000);
  assert.equal(s.audio.playing, true);
  s.session.dispose();
});

test("invalid remote input has no side effects on playing audio or pending questions", () => {
  const s = setup();
  s.session.start();
  s.session.submitQuestion("question");
  const state = s.session.getSnapshot().state;
  assert.throws(() =>
    s.session.executePlayerCommand({ type: "seek", atMs: NaN }),
  );
  assert.equal(s.requests[0].signal.aborted, false);
  assert.equal(s.session.getSnapshot().state, state);
  assert.equal(s.audio.positionMs, 31000);
  s.session.dispose();
});

test("remote controls work without analysis or model configuration", async () => {
  const s = setup();
  s.session.load({ ...episode, analysis: undefined }, null);
  s.session.metadataLoaded();
  s.session.configure({
    liveConfigured: false,
    microphone: { threshold: 0.025, minSpeechMs: 120, silenceMs: 650 },
    voiceLifecycle: { preRollMs: 750, graceMs: 5000, idleCloseMs: 60000 },
  });
  s.audio.positionMs = 31000;
  s.session.executePlayerCommand({ type: "repeat" });
  await flush();
  assert.equal(s.audio.positionMs, 21000);
  assert.equal(s.audio.playing, true);
  assert.equal(s.requests.length, 0);
  assert.equal(s.voiceCount, 0);
  s.session.dispose();
});

test("skip during a queued resume cancels the old target and keeps playing at the new one", async () => {
  const s = setup();
  s.session.start();
  s.session.submitQuestion("question");
  s.answer(0);
  await flush();
  s.session.start();
  assert.equal(s.session.getSnapshot().state.mode, "resuming");
  s.session.executePlayerCommand({ type: "skip", direction: "forward" });
  s.clock.advance(10000);
  await flush();
  assert.equal(s.audio.positionMs, 41000);
  assert.equal(s.audio.playing, true);
  assert.equal(s.session.getSnapshot().state.mode, "playing");
  assert.equal(s.session.getSnapshot().state.interruption, undefined);
  s.session.dispose();
});

test("a play failure from before a remote seek cannot stop the new playback", async () => {
  const s = setup();
  const play = s.audio.play.bind(s.audio);
  let reject!: (error: Error) => void;
  s.audio.play = () =>
    new Promise<void>((_, fail) => {
      reject = fail;
    });
  s.session.start();
  s.audio.play = play;
  s.session.executePlayerCommand({ type: "skip", direction: "forward" });
  reject(Error("old play interrupted"));
  await flush();
  assert.equal(s.audio.positionMs, 41000);
  assert.equal(s.audio.playing, true);
  assert.equal(s.session.getSnapshot().error, "");
  s.session.dispose();
});

function remoteResult(
  s: ReturnType<typeof setup>,
  index: number,
  commands: Extract<QuestionResult, { action: "player_control" }>["commands"],
  commandId = "remote-command",
) {
  s.requests[index].resolve({
    revision: s.requests[index].data.revision,
    action: "player_control",
    commandId,
    commands,
    answer: "",
    sources: [],
    tools: ["control_podcast"],
  });
}

async function liveInput(
  s: ReturnType<typeof setup>,
  text: string,
  delegation = "remote",
) {
  s.session.start();
  await flush();
  s.warm();
  s.callbacks.onSpeech(true);
  s.callbacks.onTranscript("user", text);
  s.callbacks.onDelegation(delegation);
  s.clock.advance(0);
}

test("Live speech is retained when the local detector misses a short utterance", async () => {
  const s = setup("auto");
  s.session.start();
  await flush();
  s.warm();
  s.callbacks.onTranscript("user", "Wait, wait!");
  s.callbacks.onDelegation("before-local-vad");
  s.clock.advance(0);
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].data.history.at(-1)?.text, "Wait, wait!");
  assert.equal(s.requests[0].data.player?.source, "voice");
  assert.equal(s.audio.playing, true);
  // A late local onset must not erase the transcript or cancel its request.
  s.callbacks.onSpeech(true);
  assert.equal(s.requests[0].signal.aborted, false);
  remoteResult(s, 0, [{ type: "pause" }]);
  await flush();
  assert.equal(s.audio.playing, false);
  s.session.dispose();
});

test("a delegation preceding both transcript and local speech is retained", async () => {
  const s = setup("auto");
  s.session.start();
  await flush();
  s.warm();
  s.callbacks.onDelegation("first");
  s.callbacks.onTranscript("user", "Please pause the podcast");
  s.clock.advance(120);
  assert.equal(s.requests.length, 1);
  remoteResult(s, 0, [{ type: "pause" }]);
  await flush();
  assert.equal(s.audio.playing, false);
  s.session.dispose();
});

test("a correction to a short pause request cancels the old interpretation", async () => {
  const s = setup("auto");
  await liveInput(s, "Wait", "pause-candidate");
  s.callbacks.onTranscript("user", " for me outside, honey");
  assert.equal(s.requests[0].signal.aborted, true);
  remoteResult(s, 0, [{ type: "pause" }]);
  await flush();
  assert.equal(s.audio.playing, true);
  s.session.dispose();
});

test("given ongoing speech, a Live delegation adjusts speed without pausing or waiting for speech end", async () => {
  const s = setup("auto");
  await liveInput(s, "Could you slow the podcast down");
  assert.equal(s.audio.playing, true);
  assert.equal(s.session.getSnapshot().state.interruption, undefined);
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].data.player?.positionMs, 31000);
  assert.equal(s.requests[0].data.player?.audibleSource, "podcast");
  remoteResult(s, 0, [{ type: "adjust_rate", direction: "slower" }]);
  await flush();
  assert.equal(s.audio.config.playbackRate, 0.9);
  assert.equal(s.audio.playing, true);
  assert.equal(s.audio.plays, 1);
  s.callbacks.onDelegation("duplicate-delegation");
  s.callbacks.onSpeech(false);
  s.clock.advance(1000);
  assert.equal(s.requests.length, 1);
  assert.equal(s.audio.config.playbackRate, 0.9);
  s.session.dispose();
});

test("given unrelated speech, listening and ignore leave podcast position, volume and playback alone", async () => {
  const s = setup("auto");
  await liveInput(s, "Honey, what should we have for dinner?");
  s.clock.advance(2000);
  assert.equal(s.audio.playing, true);
  assert.equal(
    s.commands.some((c) => c.startsWith("commentary:")),
    false,
  );
  s.requests[0].resolve({
    revision: s.requests[0].data.revision,
    action: "ignore",
    answer: "",
    sources: [],
    tools: [],
  });
  await flush();
  s.callbacks.onSpeech(false);
  s.clock.advance(10000);
  assert.equal(s.audio.playing, true);
  assert.equal(s.audio.positionMs, 31000);
  assert.equal(s.audio.config.volume, 1);
  assert.equal(s.session.getSnapshot().state.interruption, undefined);
  assert.equal(
    s.session.getSnapshot().history.some((t) => t.text.includes("dinner")),
    false,
  );
  s.session.dispose();
});

test("given incomplete speech, wait remains silent and a later delta can finish the same delegation", async () => {
  const s = setup("auto");
  await liveInput(s, "Could you");
  s.requests[0].resolve({
    revision: s.requests[0].data.revision,
    action: "wait",
    answer: "",
    sources: [],
    tools: [],
  });
  await flush();
  s.callbacks.onTranscript("user", " pause the podcast?");
  s.clock.advance(120);
  assert.equal(s.requests.length, 2);
  remoteResult(s, 1, [{ type: "pause" }]);
  await flush();
  assert.equal(s.audio.playing, false);
  assert.equal(s.enabled, true);
  s.clock.advance(10000);
  assert.equal(s.audio.playing, false);
  s.session.dispose();
});

test("given incremental correction, obsolete commands cannot apply while the newer text is being interpreted", async () => {
  const s = setup("auto");
  await liveInput(s, "Turn the volume");
  s.callbacks.onTranscript("user", " down to forty percent");
  assert.equal(s.requests[0].signal.aborted, true);
  remoteResult(s, 0, [{ type: "set_volume", volume: 0.8 }]);
  await flush();
  assert.equal(s.audio.config.volume, 1);
  s.clock.advance(120);
  remoteResult(s, 1, [{ type: "set_volume", volume: 0.4 }]);
  await flush();
  assert.equal(s.audio.config.volume, 0.4);
  assert.equal(s.audio.playing, true);
  s.session.dispose();
});

test("given a late repeat command, replay uses the user's original speaking position", async () => {
  const s = setup("auto");
  await liveInput(s, "I missed that last part");
  s.audio.positionMs = 55000;
  s.session.audioTick();
  remoteResult(s, 0, [{ type: "repeat" }]);
  await flush();
  assert.equal(s.audio.positionMs, 20000);
  assert.equal(s.audio.playing, true);
  s.session.dispose();
});

test("manual settings, navigation and episode switches supersede pending remote commands", async () => {
  for (const change of ["volume", "seek", "episode"] as const) {
    const s = setup("auto");
    await liveInput(s, "A little slower please");
    if (change === "volume")
      s.session.executePlayerCommand({ type: "set_volume", volume: 0.4 });
    else if (change === "seek") s.session.seek(50000);
    else s.session.load({ ...episode, id: "new" }, null);
    assert.equal(s.requests[0].signal.aborted, true);
    remoteResult(s, 0, [{ type: "adjust_rate", direction: "slower" }]);
    await flush();
    assert.equal(s.audio.config.playbackRate, 1);
    s.session.dispose();
  }
});

test("an accepted answer pauses at the speaking origin, while mere voice output cannot interrupt playback", async () => {
  const s = setup("auto");
  await liveInput(s, "Why did he say that?");
  s.callbacks.onOutput(true);
  assert.equal(s.audio.playing, true);
  s.audio.positionMs = 35000;
  s.callbacks.onSpeech(false);
  s.answer(0);
  await flush();
  assert.equal(s.audio.playing, false);
  assert.equal(s.session.getSnapshot().state.interruption?.atMs, 31000);
  assert.ok(s.commands.some((c) => c.startsWith("commentary:")));
  s.session.dispose();
});

test("a combined control and question applies the control before starting the answer request", async () => {
  const s = setup("auto");
  await liveInput(s, "Pause, and why did he say that?");
  s.requests[0].resolve({
    revision: s.requests[0].data.revision,
    action: "player_control",
    commandId: "mixed",
    commands: [{ type: "pause" }],
    followUpQuestion: "Why did he say that?",
    answer: "",
    sources: [],
    tools: [],
  });
  await flush();
  assert.equal(s.audio.playing, false);
  assert.equal(s.requests.length, 2);
  assert.equal(s.requests[1].data.history.at(-1)?.text, "Why did he say that?");
  s.answer(1);
  await flush();
  assert.ok(s.commands.some((c) => c.startsWith("commentary:")));
  s.session.dispose();
});

test("a new delegated clause in the same speech turn receives the already-handled prefix", async () => {
  const s = setup("auto");
  await liveInput(s, "Slow the podcast down");
  remoteResult(s, 0, [{ type: "adjust_rate", direction: "slower" }], "slow");
  await flush();
  s.callbacks.onTranscript(
    "user",
    ", and turn the volume down to forty percent",
  );
  s.callbacks.onDelegation("additional-volume");
  s.clock.advance(0);
  assert.equal(s.requests.length, 2);
  assert.equal(s.requests[1].data.player?.handledText, "Slow the podcast down");
  assert.equal(s.requests[1].data.player?.config.playbackRate, 0.9);
  remoteResult(s, 1, [{ type: "set_volume", volume: 0.4 }], "volume");
  await flush();
  assert.equal(s.audio.config.playbackRate, 0.9);
  assert.equal(s.audio.config.volume, 0.4);
  s.session.dispose();
});

test("manual configuration commands restore the exact position if playback was active before recording", async () => {
  const s = setup("manual");
  s.session.start();
  await s.session.beginManual();
  s.session.endManual();
  s.callbacks.onFirstQuestion("Turn the podcast down to forty percent");
  assert.equal(s.requests[0].data.player?.wasPlaying, true);
  remoteResult(s, 0, [{ type: "set_volume", volume: 0.4 }]);
  await flush();
  assert.equal(s.audio.config.volume, 0.4);
  assert.equal(s.audio.playing, true);
  assert.equal(s.audio.positionMs, 31000);
  s.session.dispose();
});

test("a second breath preserves pending context without exposing unclassified speech in the chat", async () => {
  const s = setup("auto");
  await liveInput(s, "Slow the podcast down");
  assert.equal(s.session.getSnapshot().history.length, 0);
  s.callbacks.onSpeech(false);
  s.callbacks.onSpeech(true);
  s.callbacks.onTranscript("user", "and lower the volume too");
  assert.equal(s.session.getSnapshot().history.length, 0);
  assert.equal(s.requests[0].signal.aborted, true);
  s.callbacks.onDelegation("second-breath");
  s.clock.advance(0);
  assert.deepEqual(
    s.requests[1].data.history.map((turn) => turn.text),
    ["Slow the podcast down", "and lower the volume too"],
  );
  remoteResult(s, 1, [
    { type: "adjust_rate", direction: "slower" },
    { type: "set_volume", volume: 0.8 },
  ]);
  await flush();
  assert.equal(s.audio.config.playbackRate, 0.9);
  assert.equal(s.audio.config.volume, 0.8);
  assert.equal(s.audio.playing, true);
  s.session.dispose();
});

test("server stream owns voice decisions; frontend captions, delegation and VAD never request intent", async () => {
  const s = setup("auto", undefined, undefined, true, true);
  s.session.start();
  await flush();
  s.callbacks.onSpeech(true);
  s.callbacks.onTranscript("user", "Any phrase without a trigger word");
  s.callbacks.onDelegation("also-visible-in-browser");
  s.clock.advance(2000);
  await flush();
  assert.equal(s.requests.length, 0);
  assert.equal(
    s.audio.playing,
    false,
    "speech stops the podcast; the server decides what it was",
  );
  s.push({
    type: "observing",
    version: s.serverState.version,
    text: "Any phrase",
  });
  s.push({
    type: "classifying",
    version: s.serverState.version,
    text: "Any phrase",
  });
  assert.equal(
    (await s.session.voiceDiagnostics()).recognition?.submittedText,
    "Any phrase",
  );
  const speed = s.decision("player_control", [
    { type: "adjust_rate", direction: "slower" },
  ]);
  s.push(speed);
  s.push(speed);
  await flush();
  assert.equal(s.audio.config.playbackRate, 0.9);
  assert.equal(s.audio.playing, true);
  assert.equal(
    s.updates.filter((x) => x.acknowledgement?.decisionId === speed.decisionId)
      .length,
    1,
  );
  s.push(s.decision("player_control"));
  await flush();
  assert.equal(s.audio.playing, false);
  assert.equal(s.enabled, true);
  assert.equal(s.requests.length, 0);
  s.session.dispose();
});

test("server ignore and wait do not pause, duck or persist bystander speech", async () => {
  const s = setup("auto", undefined, undefined, false, true);
  s.session.start();
  await flush();
  s.push(s.decision("ignore"));
  s.push(s.decision("wait"));
  await flush();
  assert.equal(s.audio.playing, true);
  assert.equal(s.audio.config.volume, 1);
  assert.deepEqual(s.session.checkpoint().history, []);
  assert.equal(
    s.commands.some((x) => x.startsWith("commentary:")),
    false,
  );
  s.session.dispose();
});

test("manual settings invalidate a queued server decision and report rejection", async () => {
  const s = setup("auto", undefined, undefined, false, true);
  s.session.start();
  await flush();
  const old = s.decision("player_control");
  s.session.setPlaybackRate(1.2);
  s.push(old);
  await flush();
  assert.equal(s.audio.playing, true);
  assert.equal(s.audio.config.playbackRate, 1.2);
  assert.equal(s.updates.at(-1)?.acknowledgement?.applied, false);
  const stale = s.decision("player_control");
  s.session.load({ ...episode, id: "another" }, null);
  s.push(stale);
  await flush();
  assert.equal(s.session.getSnapshot().history.length, 0);
  s.session.dispose();
});

test("a pushed answer pauses only when accepted and mixed questions never submit a second frontend request", async () => {
  const s = setup("auto", undefined, undefined, false, true);
  s.session.start();
  await flush();
  const mixed = s.decision("player_control", [
    { type: "adjust_rate", direction: "slower" },
  ]);
  if (mixed.result.action === "player_control")
    mixed.result.followUpQuestion = "What did that mean?";
  s.push(mixed);
  await flush();
  assert.equal(s.requests.length, 0);
  assert.equal(s.audio.playing, true);
  s.push(s.decision("answer"));
  await flush();
  assert.equal(s.audio.playing, false);
  assert.ok(s.commands.includes("commentary:An answer"));
  assert.equal(s.requests.length, 0);
  s.session.dispose();
});

test("a control-only delegation discards buffered voice output unless a reply window is open", async () => {
  const s = setup("auto", undefined, undefined, false, true);
  s.session.start();
  await flush();
  s.push({ type: "classifying", version: s.serverState.version });
  await flush();
  const before = s.commands.filter((c) => c === "discardPendingOutput").length;
  s.push({ type: "discard", version: s.serverState.version });
  await flush();
  assert.equal(
    s.commands.filter((c) => c === "discardPendingOutput").length,
    before + 1,
  );
  s.session.dispose();
});

test("under server control the voice is never handed the podcast text, which it would answer from by itself", async () => {
  const s = setup("auto", undefined, undefined, false, true);
  s.session.start();
  await flush();
  s.audio.positionMs = 45000;
  s.session.audioTick();
  await flush();
  assert.deepEqual(
    s.commands.filter((c) => c.startsWith("thinking:")),
    [],
    "the backend's instructions carry what was heard",
  );
  s.session.dispose();

  const client = setup("auto");
  client.session.start();
  await flush();
  client.audio.positionMs = 45000;
  client.session.audioTick();
  await flush();
  const context = client.commands.filter((c) => c.startsWith("thinking:"));
  assert.ok(context.length > 0, "a voice that answers itself still needs it");
  assert.equal(
    context.some((c) => /[\u4e00-\u9fff]/.test(JSON.parse(c.slice(9)).note)),
    false,
    "and no Chinese note pulls its speech towards Chinese",
  );
  client.session.dispose();
});

for (const mobile of [false, true])
test(`${mobile ? "mobile" : "Web"}: an early ignore that the backend overrules still becomes an answered question`, async () => {
  const s = setup(
    "auto", undefined, undefined, false, true,
    mobile ? "verified" : "quiet",
    { speechYield: mobile ? "duck" : "pause" },
  );
  s.session.start();
  await flush();
  const input = { turnId: "server-turn", startMs: 0 };
  const player = { ...s.serverState, source: "voice" as const, turnId: "server-turn" };
  s.callbacks.onSpeech(true);
  s.push({ type: "observing", version: s.serverState.version, input });
  s.push({ type: "classifying", version: s.serverState.version, input });
  await flush();
  assert.equal(s.audio.playing, mobile, "mobile ducks speech; Web pauses before admission");
  if (mobile) assert.ok(s.audio.level > 0 && s.audio.level < 1);
  s.callbacks.onSpeech(false);
  s.push({
    type: "decision",
    version: s.serverState.version,
    input,
    decisionId: crypto.randomUUID(),
    player,
    text: "",
    result: {
      revision: s.serverState.revision,
      action: "ignore",
      answer: "",
      sources: [],
      tools: ["ignore_input"],
    },
  });
  await flush();
  assert.equal(s.audio.playing, true, "the fast classifier let the podcast continue");
  assert.equal(s.session.getSnapshot().state.interruption, undefined);
  const decisionId = crypto.randomUUID();
  s.push({
    type: "engage",
    version: s.serverState.version,
    revision: s.serverState.revision,
    input,
    decisionId,
    player,
    text: "Is that actually true?",
  });
  await flush();
  assert.equal(s.audio.playing, false, "the backend's answer takes it back");
  assert.ok(s.session.getSnapshot().state.interruption);
  assert.equal(s.updates.at(-1)?.acknowledgement?.decisionId, decisionId);
  assert.equal(s.updates.at(-1)?.acknowledgement?.applied, true);
  assert.ok(
    s.commands.lastIndexOf("mute:false") > s.commands.lastIndexOf("discardPendingOutput"),
    "the reply window opens after the ignored output was dropped",
  );
  assert.equal(s.session.getSnapshot().history.at(-1)?.text, "Is that actually true?");
  s.session.dispose();
});

test("a delegated engage pauses the podcast, opens the reply window without client text, and records the answer's sources", async () => {
  const s = setup("auto", undefined, undefined, false, true);
  s.session.start();
  await flush();
  const decisionId = crypto.randomUUID();
  s.push({
    type: "engage",
    version: s.serverState.version,
    revision: s.serverState.revision,
    decisionId,
    player: { ...s.serverState, source: "voice", turnId: "server-turn" },
    text: "What is a biography?",
  });
  await flush();
  assert.equal(s.audio.playing, false, "the backend is answering: hard yield");
  assert.equal(
    s.commands.some((c) => c.startsWith("commentary:")),
    false,
    "the voice speaks the backend's answer itself",
  );
  assert.ok(s.commands.includes("mute:false"), "the reply audio window opens");
  assert.equal(s.updates.at(-1)?.acknowledgement?.decisionId, decisionId);
  assert.equal(s.updates.at(-1)?.acknowledgement?.applied, true);
  assert.equal(s.updates.at(-1)?.player.assistant?.state, "queued");
  assert.equal(
    s.session.getSnapshot().history.at(-1)?.text,
    "What is a biography?",
  );
  assert.equal(s.requests.length, 0, "no frontend question request");
  s.push({
    type: "answered",
    decisionId,
    answer: "A biography is a life story.",
    sources: [
      { text: "A biography tells someone else's life story.", startMs: 20000 },
    ],
  });
  await flush();
  assert.equal(s.session.getSnapshot().sources.length, 1);
  // The spoken words arrive as the voice transcript, not as client text.
  s.callbacks.onOutput(true);
  s.callbacks.onTranscript("assistant", "A biography is a life story.");
  s.callbacks.onOutput(false);
  await flush();
  assert.equal(s.session.getSnapshot().history.at(-1)?.role, "assistant");
  assert.equal(
    s.session.getSnapshot().resumeSeconds,
    3,
    "a finished answer opens the follow-up window",
  );
  const stale = {
    type: "engage" as const,
    version: s.serverState.version + 5,
    revision: s.serverState.revision,
    decisionId: crypto.randomUUID(),
    player: { ...s.serverState, source: "voice" as const, turnId: "later" },
    text: "stale",
  };
  s.push(stale);
  await flush();
  assert.equal(s.updates.at(-1)?.acknowledgement?.applied, false);
  s.session.dispose();
});

for (const previousDelegation of [false, true]) {
  test(`a submitted spoken answer keeps its captions and saved history with server control (previous delegation: ${previousDelegation})`, async (t) => {
    const s = setup("auto", undefined, undefined, false, true);
    t.after(() => s.session.dispose());
    s.session.start();
    await flush();
    const previous: string[] = [];
    if (previousDelegation) {
      const decision = s.decision("answer");
      s.push(decision);
      s.callbacks.onOutput(true);
      s.callbacks.onTranscript("assistant", "Earlier spoken answer");
      s.callbacks.onOutput(false);
      previous.push(decision.text, "Earlier spoken answer");
    }
    s.session.submitQuestion("200 文大概多少钱？", true);
    s.answer(0, "A planned answer, not the spoken wording");
    await flush();
    assert.deepEqual(
      s.session.getSnapshot().history.map((t) => t.text),
      [...previous, "200 文大概多少钱？"],
    );
    s.callbacks.onOutput(true);
    s.callbacks.onTranscript("assistant", "二百文的购买力");
    s.callbacks.onTranscript("assistant", "要看时代和地区。");
    s.callbacks.onOutput(false);
    const expected = [
      ...previous,
      "200 文大概多少钱？",
      "二百文的购买力要看时代和地区。",
    ];
    assert.deepEqual(
      s.session.getSnapshot().history.map((t) => t.text),
      expected,
    );
    assert.deepEqual(
      s.session.checkpoint().history.map((t) => t.text),
      expected,
    );
    s.session.stop();
    s.callbacks.onTranscript(
      "assistant",
      "This muted caption must not be saved",
    );
    const checkpoint = s.session.checkpoint();
    s.session.load(episode, checkpoint);
    assert.deepEqual(
      s.session.getSnapshot().history.map((t) => t.text),
      expected,
    );
  });
}

test("a cold first question answered through HTTP keeps its spoken history in a server-controlled session", async (t) => {
  const s = setup("auto", undefined, undefined, false, true);
  t.after(() => s.session.dispose());
  const connected = s.holdLive();
  s.session.start();
  await flush();
  s.callbacks.onSpeech(true);
  s.callbacks.onSpeech(false);
  connected();
  await flush();
  s.callbacks.onFirstQuestion("What does two hundred wen mean?");
  assert.equal(s.requests.length, 1);
  s.answer(0, "A planned reply");
  await flush();
  s.callbacks.onOutput(true);
  s.callbacks.onTranscript(
    "assistant",
    "Its purchasing power depends on the period.",
  );
  s.callbacks.onOutput(false);
  assert.deepEqual(
    s.session.checkpoint().history.map((t) => t.text),
    [
      "What does two hundred wen mean?",
      "Its purchasing power depends on the period.",
    ],
  );
});

for (const spokenResume of ["quiet", "verified"] as const) {
  test(`barge-in also cuts a first-connection HTTP answer without a Live reply ID (${spokenResume})`, async (t) => {
    const s = setup("auto", undefined, undefined, false, true, spokenResume);
    t.after(() => s.session.dispose());
    const connected = s.holdLive();
    s.session.start();
    await flush();
    s.callbacks.onSpeech(true);
    s.callbacks.onSpeech(false);
    connected();
    await flush();
    s.callbacks.onFirstQuestion("Explain this story");
    s.answer(0, "A planned reply");
    await flush();
    s.callbacks.onOutput(true);
    s.callbacks.onTranscript("assistant", "The heard prefix");
    s.commands.length = 0;
    s.callbacks.onSpeech(true);
    assert.ok(s.commands.includes("interrupt"));
    assert.equal(s.commands.includes("prepareOutput"), false);
    s.callbacks.onTranscript("assistant", " unheard tail");
    assert.deepEqual(
      s.session.checkpoint().history.map((t) => t.text),
      ["Explain this story", "The heard prefix"],
    );
    s.callbacks.onSpeech(false);
    assert.equal(s.commands.at(-1), "prepareOutput");
  });
}

test("an ignored server interpretation cannot resume the podcast after voice output goes quiet", async () => {
  const s = setup("auto", undefined, undefined, false, true);
  s.session.start();
  await flush();
  s.push(s.decision("answer"));
  await flush();
  s.callbacks.onOutput(true);
  s.callbacks.onOutput(false);
  s.clock.advance(1000);
  s.push({ type: "classifying", version: s.serverState.version });
  s.clock.advance(5000);
  await flush();
  assert.equal(s.audio.playing, false);
  s.push(s.decision("ignore"));
  s.clock.advance(3000);
  await flush();
  assert.equal(s.audio.playing, false);
  assert.equal(s.session.getSnapshot().resumeSeconds, null);
  s.session.dispose();
});

test("typing updates the composer immediately and accepted send clears it while pending", () => {
  const s = setup();
  s.session.setQuestion("A paused-player question");
  assert.equal(s.session.getSnapshot().question, "A paused-player question");
  s.session.submitQuestion(s.session.getSnapshot().question);
  assert.equal(s.requests.length, 1);
  assert.equal(s.session.getSnapshot().question, "");
  assert.equal(s.session.getSnapshot().busy, true);
  s.session.setQuestion("The next draft");
  assert.equal(s.session.getSnapshot().question, "The next draft");
  s.session.dispose();
});

test("stream previews stay out of checkpoints and late cancelled chunks cannot change the next turn", async () => {
  const s = setup();
  s.session.submitQuestion("First");
  s.requests[0].preview!("Partial answer");
  assert.equal(s.session.getSnapshot().answerPreview, "Partial answer");
  assert.deepEqual(
    s.session.checkpoint().history.map((t) => t.text),
    ["First"],
  );
  s.session.submitQuestion("Second");
  s.requests[0].preview!("Late stale answer");
  assert.equal(s.session.getSnapshot().answerPreview, "");
  s.requests[1].preview!("Current answer");
  s.session.setQuestion("Next draft");
  s.answer(1, "Complete answer");
  await flush();
  assert.equal(s.session.getSnapshot().answerPreview, "");
  assert.equal(s.session.getSnapshot().question, "Next draft");
  assert.equal(s.session.checkpoint().history.at(-1)?.text, "Complete answer");
  assert.deepEqual(
    s.session.checkpoint().history.map((t) => t.text),
    ["First", "Second", "Complete answer"],
  );
  s.session.dispose();
});

test("a Live delegation ducks the playing podcast and an ignore decision restores it without pausing", async () => {
  const s = setup("auto");
  await liveInput(s, "Honey, what should we have for dinner?");
  assert.deepEqual(s.audio.ducks, [attention.level]);
  assert.equal(s.audio.playing, true);
  s.requests[0].resolve({
    revision: s.requests[0].data.revision,
    action: "ignore",
    answer: "",
    sources: [],
    tools: [],
  });
  await flush();
  assert.deepEqual(s.audio.ducks, [attention.level, 1]);
  assert.equal(s.audio.playing, true);
  assert.equal(s.audio.positionMs, 31000);
  assert.equal(s.audio.settles, 0);
  s.clock.advance(attention.holdMs);
  assert.deepEqual(s.audio.ducks, [attention.level, 1]);
  s.session.dispose();
});

test("a soft yield without a decision releases after the hold window", async () => {
  const s = setup("auto");
  await liveInput(s, "Hmm");
  s.requests[0].resolve({
    revision: s.requests[0].data.revision,
    action: "wait",
    answer: "",
    sources: [],
    tools: [],
  });
  await flush();
  assert.deepEqual(s.audio.ducks, [attention.level]);
  s.clock.advance(attention.holdMs - 1);
  assert.deepEqual(s.audio.ducks, [attention.level]);
  s.clock.advance(1);
  assert.deepEqual(s.audio.ducks, [attention.level, 1]);
  assert.equal(s.audio.playing, true);
  s.session.dispose();
});

test("an accepted answer settles the podcast instead of cutting it and keeps the speaking origin", async () => {
  const s = setup("auto");
  await liveInput(s, "Why did he say that?");
  s.audio.positionMs = 35000;
  s.callbacks.onSpeech(false);
  s.answer(0);
  await flush();
  assert.equal(s.audio.settles, 1);
  assert.equal(s.audio.playing, false);
  assert.equal(s.audio.level, 1);
  assert.equal(s.session.getSnapshot().state.interruption?.atMs, 31000);
  s.clock.advance(attention.holdMs);
  assert.deepEqual(s.audio.ducks, [attention.level]);
  s.session.dispose();
});

test("a delegated speed change releases the soft yield once applied", async () => {
  const s = setup("auto");
  await liveInput(s, "a bit slower please");
  remoteResult(s, 0, [{ type: "adjust_rate", direction: "slower" }]);
  await flush();
  assert.deepEqual(s.audio.ducks, [attention.level, 1]);
  assert.equal(s.audio.playing, true);
  assert.equal(s.audio.config.playbackRate, 0.9);
  assert.equal(s.audio.settles, 0);
  s.session.dispose();
});

test("a spoken pause fades out, then stops at the requested position while listening stays on", async () => {
  const s = setup("auto");
  await liveInput(s, "wait wait");
  remoteResult(s, 0, [{ type: "pause" }]);
  await flush();
  assert.equal(s.audio.settles, 1);
  assert.equal(s.audio.playing, false);
  assert.equal(s.audio.positionMs, 31000);
  assert.equal(s.session.getSnapshot().state.mode, "paused");
  assert.equal(s.session.getSnapshot().listeningActive, true);
  s.session.dispose();
});

test("server classifying ducks the podcast; observing alone and an ignore decision leave it at full volume", async () => {
  const s = setup("auto", undefined, undefined, false, true);
  s.session.start();
  await flush();
  s.push({ type: "observing", version: s.serverState.version, text: "Hmm" });
  assert.deepEqual(s.audio.ducks, []);
  s.push({ type: "classifying", version: s.serverState.version, text: "Hmm" });
  assert.deepEqual(s.audio.ducks, [attention.level]);
  s.push(s.decision("ignore"));
  await flush();
  assert.deepEqual(s.audio.ducks, [attention.level, 1]);
  assert.equal(s.audio.playing, true);
  assert.equal(s.audio.settles, 0);
  s.session.dispose();
});

test("a server pause decision fades out instead of cutting the podcast", async () => {
  const s = setup("auto", undefined, undefined, false, true);
  s.session.start();
  await flush();
  s.push({ type: "classifying", version: s.serverState.version, text: "wait" });
  s.push(s.decision("player_control"));
  await flush();
  assert.equal(s.audio.settles, 1);
  assert.equal(s.audio.playing, false);
  assert.equal(s.audio.level, 1);
  assert.equal(s.session.getSnapshot().listeningActive, true);
  s.session.dispose();
});

test("a session start that outlives its connection is closed at once so its replacement is not refused", async (t) => {
  const s = setup("auto", undefined, undefined, false, true);
  t.after(() => s.session.dispose());
  const release = s.holdLive();
  s.session.start();
  await flush();
  // The listener stops while the server is still creating the session.
  s.session.stop();
  release();
  await flush();
  assert.deepEqual(s.usages, [
    { sessionId: "test-session", seconds: 0, finalized: false, closed: true },
  ]);
});

test("a session start that is still wanted is not closed", async (t) => {
  const s = setup("auto", undefined, undefined, false, true);
  t.after(() => s.session.dispose());
  s.session.start();
  await flush();
  assert.deepEqual(s.usages, []);
});

test("hearing someone speak stops the podcast at once, and bystander talk or noise lets it continue", async () => {
  const s = setup("auto", undefined, undefined, false, true);
  s.session.start();
  await flush();
  s.callbacks.onSpeech(true);
  assert.equal(s.audio.playing, false, "stopped before any transcript");
  assert.equal(
    s.session.getSnapshot().state.mode,
    "playing",
    "a soft yield is not an interruption",
  );
  // A long utterance outlasts the hold without the podcast coming back over it.
  s.clock.advance(attention.holdMs * 3);
  assert.equal(s.audio.playing, false);
  s.push({ type: "classifying", version: s.serverState.version });
  s.callbacks.onSpeech(false);
  assert.equal(s.audio.playing, false, "classification never restarts it");
  assert.deepEqual(s.audio.ducks, [], "a stop is not a volume change");
  s.push(s.decision("ignore"));
  await flush();
  assert.equal(s.audio.playing, true, "bystander talk: the podcast continues");
  // Speech that produces no transcript continues on its own after the hold.
  s.callbacks.onSpeech(true);
  s.callbacks.onSpeech(false);
  assert.equal(s.audio.playing, false);
  s.clock.advance(attention.holdMs - 1);
  assert.equal(s.audio.playing, false);
  s.clock.advance(1);
  await flush();
  assert.equal(s.audio.playing, true);
  assert.equal(s.session.getSnapshot().state.interruption, undefined);
  s.session.dispose();
});

test("a speech detector that never reports the end cannot strand the podcast", async () => {
  const s = setup("auto", undefined, undefined, false, true);
  s.session.start();
  await flush();
  s.callbacks.onSpeech(true);
  s.clock.advance(attention.speechHoldMs - attention.holdMs);
  assert.equal(s.audio.playing, false);
  s.clock.advance(attention.holdMs * 2);
  await flush();
  assert.equal(s.audio.playing, true);
  s.session.dispose();
});

test("a question after the speech stop becomes an interruption at the position where speech began", async () => {
  const s = setup("auto", undefined, undefined, false, true);
  s.session.start();
  await flush();
  s.callbacks.onSpeech(true);
  assert.equal(s.audio.playing, false);
  s.callbacks.onSpeech(false);
  s.push({
    type: "engage",
    version: s.serverState.version,
    revision: s.serverState.revision,
    decisionId: crypto.randomUUID(),
    player: { ...s.serverState, source: "voice", turnId: "server-turn" },
    text: "What is a biography?",
  });
  await flush();
  assert.equal(s.audio.playing, false);
  assert.ok(
    s.session.getSnapshot().state.interruption,
    "the soft stop became an interruption",
  );
  s.clock.advance(attention.holdMs * 2);
  await flush();
  assert.equal(
    s.audio.playing,
    false,
    "the expired hold cannot restart an interrupted podcast",
  );
  s.session.dispose();
});

test("under server voice control only a backend answer is heard or recorded", async () => {
  const s = setup("auto", undefined, undefined, false, true);
  s.session.start();
  await flush();
  s.push(s.decision("player_control"));
  await flush();
  const lastMute = () => s.commands.filter((x) => x.startsWith("mute:")).at(-1);
  // The voice acknowledges the pause on its own initiative.
  s.commands.length = 0;
  s.callbacks.onOutput(true);
  s.callbacks.onTranscript("assistant", "好,我等一下");
  s.callbacks.onOutput(false);
  assert.equal(lastMute(), "mute:true");
  assert.equal(s.commands.includes("mute:false"), false);
  assert.deepEqual(
    s.session.getSnapshot().history.map((t) => [t.role, t.text]),
    [["user", "A spoken request"]],
  );
  assert.equal(s.session.getSnapshot().state.assistantSpeaking, false);
  // A backend answer opens the window...
  s.push(s.decision("answer"));
  await flush();
  assert.equal(lastMute(), "mute:false");
  s.callbacks.onOutput(true);
  s.callbacks.onTranscript("assistant", "An answer");
  assert.equal(s.session.getSnapshot().state.assistantSpeaking, true);
  assert.equal(s.session.getSnapshot().history.at(-1)?.text, "An answer");
  // New listener input cannot cut off the accepted answer, even in a quiet gap.
  s.push({ type: "observing", version: s.serverState.version });
  assert.equal(lastMute(), "mute:false");
  s.callbacks.onOutput(false);
  s.push({ type: "observing", version: s.serverState.version });
  assert.equal(lastMute(), "mute:false");
  s.callbacks.onOutput(true);
  s.callbacks.onTranscript("assistant", " with a continuation");
  assert.equal(
    s.session.getSnapshot().history.at(-1)?.text,
    "An answer with a continuation",
  );
  s.push(s.decision("player_control"));
  await flush();
  s.callbacks.onTranscript("assistant", " muted after an accepted control");
  assert.equal(lastMute(), "mute:true");
  assert.equal(
    s.session.getSnapshot().history.some((t) => t.text.includes("muted after")),
    false,
  );
  s.session.dispose();
});

test("early admission opens speech before the answer, then completes the same bubble exactly once", async (t) => {
  const s = setup("auto", undefined, undefined, false, true);
  t.after(() => s.session.dispose());
  s.session.start();
  await flush();
  assert.equal(s.liveRequests[0].control?.earlyResponse, true);
  const decision = s.decision("answer");
  decision.answerPending = true;
  decision.result.answer = "";
  s.push(decision);
  await flush();
  assert.equal(
    s.commands.filter((c) => c.startsWith("mute:")).at(-1),
    "mute:false",
  );
  assert.equal(s.audio.playing, false);
  assert.equal(s.session.getSnapshot().busy, true);
  assert.equal(
    s.commands.includes("commentary:"),
    false,
    "no empty result is sent to Live",
  );
  s.callbacks.onOutput(true);
  s.callbacks.onTranscript("assistant", "让我想一下。");
  assert.deepEqual(
    s.session.getSnapshot().history.map((t) => t.text),
    [decision.text, "让我想一下。"],
  );
  const complete: Extract<LiveControlEvent, { type: "answer" }> = {
    type: "answer",
    version: decision.version,
    decisionId: decision.decisionId,
    result: {
      action: "answer",
      revision: decision.result.revision,
      answer: "真实答案",
      sources: [],
      tools: [],
    },
  };
  s.push(complete);
  s.push(complete);
  assert.equal(s.commands.filter((c) => c === "commentary:真实答案").length, 1);
  assert.equal(s.session.getSnapshot().busy, false);
  assert.deepEqual(
    s.session.checkpoint().history.map((t) => t.text),
    [decision.text, "让我想一下。"],
    "planned answer is not recorded as heard",
  );
  s.callbacks.onTranscript("assistant", "解释来了。");
  assert.deepEqual(
    s.session.getSnapshot().history.map((t) => t.text),
    [decision.text, "让我想一下。解释来了。"],
  );
  assert.equal(s.requests.length, 0);
});

test("a cancelled early answer cannot inject late content after resume or a replacement question", async (t) => {
  const s = setup("auto", undefined, undefined, false, true);
  t.after(() => s.session.dispose());
  s.session.start();
  await flush();
  const first = s.decision("answer");
  first.answerPending = true;
  first.result.answer = "";
  s.push(first);
  await flush();
  const next = s.decision("answer");
  s.push(next);
  await flush();
  s.push({
    type: "answer",
    version: first.version,
    decisionId: first.decisionId,
    result: {
      action: "answer",
      revision: first.result.revision,
      answer: "Stale answer",
      sources: [],
      tools: [],
    },
  });
  assert.equal(s.commands.includes("commentary:Stale answer"), false);
  s.session.executePlayerCommand({ type: "play" });
  s.clock.advance(0);
  await flush();
  assert.equal(s.session.getSnapshot().busy, false);
});

test("interrupting a speaking answer puts early progress after its own question and preserves the heard prefix", async (t) => {
  const s = setup("auto", undefined, undefined, false, true);
  t.after(() => s.session.dispose());
  s.session.start();
  await flush();
  const first = {
    ...s.decision("answer"),
    text: "讲讲阿Q正传",
    input: { turnId: "first", startMs: 1000 },
  };
  s.push(first);
  await flush();
  s.callbacks.onOutput(true);
  s.callbacks.onTranscript("assistant", "上一条回答", {
    startMs: 2000,
    endMs: 2500,
  });
  // The model's progress can beat the sideband observation, let alone its decision.
  s.callbacks.onTranscript("assistant", "我来查一下。", {
    startMs: 5000,
    endMs: 5500,
  });
  s.push({
    type: "observing",
    version: s.serverState.version,
    input: { turnId: "second", startMs: 4000 },
  });
  assert.deepEqual(
    s.session.getSnapshot().history.map((t) => t.text),
    ["讲讲阿Q正传", "上一条回答"],
  );
  s.clock.advance(250);
  await flush();
  assert.equal(s.serverState.assistant?.text, "上一条回答");
  const second = {
    ...s.decision("answer"),
    text: "阿Q为什么叫阿Q？",
    input: { turnId: "second", startMs: 4000 },
  };
  s.push(second);
  await flush();
  s.callbacks.onTranscript("assistant", "这个名字……", {
    startMs: 6000,
    endMs: 6500,
  });
  // A delayed caption from the interrupted answer still belongs to its old bubble.
  s.callbacks.onTranscript("assistant", "的结尾。", {
    startMs: 3000,
    endMs: 3500,
  });
  const expected = [
    "讲讲阿Q正传",
    "上一条回答的结尾。",
    "阿Q为什么叫阿Q？",
    "我来查一下。这个名字……",
  ];
  assert.deepEqual(
    s.session.getSnapshot().history.map((t) => t.text),
    expected,
  );
  assert.deepEqual(
    s.session.checkpoint().history.map((t) => t.text),
    expected,
  );
  s.clock.advance(250);
  await flush();
  assert.equal(s.serverState.assistant?.text, "我来查一下。这个名字……");
  assert.equal(s.requests.length, 0);
  assert.equal(s.audio.playing, false);
});

test("bystander captions return to the accepted reply without creating a question bubble", async (t) => {
  const s = setup("auto", undefined, undefined, false, true);
  t.after(() => s.session.dispose());
  s.session.start();
  await flush();
  s.push({ ...s.decision("answer"), input: { turnId: "a", startMs: 1000 } });
  s.callbacks.onOutput(true);
  s.callbacks.onTranscript("assistant", "A reply", {
    startMs: 2000,
    endMs: 2500,
  });
  await flush();
  s.push({
    type: "observing",
    version: s.serverState.version,
    input: { turnId: "b", startMs: 3000 },
  });
  s.callbacks.onTranscript("assistant", " continues", {
    startMs: 4000,
    endMs: 4500,
  });
  assert.equal(s.session.getSnapshot().history.at(-1)?.text, "A reply");
  s.push({ ...s.decision("wait"), input: { turnId: "b", startMs: 3000 } });
  assert.equal(s.session.getSnapshot().history.at(-1)?.text, "A reply");
  s.push({ ...s.decision("ignore"), input: { turnId: "b", startMs: 3000 } });
  assert.deepEqual(
    s.session.checkpoint().history.map((t) => t.text),
    ["A spoken request", "A reply continues"],
  );
  assert.equal(s.session.getSnapshot().state.assistantSpeaking, true);
});

test("late old captions do not commit a queued new reply before it plays", async (t) => {
  const s = setup("auto", undefined, undefined, false, true);
  t.after(() => s.session.dispose());
  s.session.start();
  await flush();
  s.push({ ...s.decision("answer"), input: { turnId: "a", startMs: 1000 } });
  s.callbacks.onOutput(true);
  s.callbacks.onTranscript("assistant", "Heard", {
    startMs: 2000,
    endMs: 2500,
  });
  s.callbacks.onOutput(false);
  await flush();
  s.push({
    ...s.decision("answer"),
    text: "New question",
    input: { turnId: "b", startMs: 4000 },
  });
  await flush();
  s.callbacks.onTranscript("assistant", "Not yet heard", {
    startMs: 5000,
    endMs: 5500,
  });
  s.callbacks.onTranscript("assistant", " old tail", {
    startMs: 3000,
    endMs: 3500,
  });
  assert.deepEqual(
    s.session.checkpoint().history.map((t) => t.text),
    ["A spoken request", "Heard old tail", "New question"],
  );
  await flush();
  s.push({
    ...s.decision("answer"),
    text: "Another question",
    input: { turnId: "c", startMs: 6000 },
  });
  assert.equal(
    s.session.getSnapshot().history.some((t) => t.text === "Not yet heard"),
    false,
  );
  assert.equal(
    s.session.checkpoint().history.some((t) => t.text === "Not yet heard"),
    false,
  );
});

test("one voice conversation reports delivered replies and playback state without asking a frontend classifier", async () => {
  const s = setup("auto", undefined, undefined, false, true);
  s.session.start();
  await flush();
  const answer = s.decision("answer");
  s.push(answer);
  await flush();
  assert.equal(s.serverState.playback?.interrupted, true);
  assert.deepEqual(s.serverState.assistant, {
    decisionId: answer.decisionId,
    text: "",
    state: "queued",
  });
  assert.equal(s.session.checkpoint().history.at(-1)?.text, answer.text);
  s.callbacks.onOutput(true);
  s.callbacks.onTranscript("assistant", "Shall I resume");
  s.callbacks.onTranscript("assistant", " the podcast?");
  s.clock.advance(250);
  await flush();
  assert.equal(s.serverState.assistant?.text, "Shall I resume the podcast?");
  assert.equal(s.serverState.assistant?.state, "speaking");
  s.callbacks.onOutput(false);
  await flush();
  assert.equal(s.serverState.assistant?.state, "quiet");
  assert.equal(s.serverState.playback?.mode, "awaiting_followup");
  s.push(s.decision("resume"));
  s.clock.advance(0);
  await flush();
  assert.equal(
    s.audio.playing,
    true,
    "resume tool has no artificial 1.5 second delay",
  );
  assert.equal(s.serverState.playback?.mode, "playing");
  assert.equal(s.requests.length, 0);
  s.callbacks.onTranscript("assistant", "muted unsolicited tail");
  s.clock.advance(250);
  await flush();
  assert.equal(s.serverState.assistant?.text, "Shall I resume the podcast?");
  s.session.dispose();
});

test("interrupting a spoken reply reports the admitted prefix, never its planned ending", async () => {
  const s = setup("auto", undefined, undefined, false, true);
  s.session.start();
  await flush();
  s.push(s.decision("answer"));
  await flush();
  s.callbacks.onOutput(true);
  s.callbacks.onTranscript("assistant", "The first part");
  s.session.executePlayerCommand({ type: "play" });
  s.clock.advance(0);
  await flush();
  assert.equal(s.serverState.assistant?.state, "interrupted");
  assert.equal(s.serverState.assistant?.text, "The first part");
  s.session.dispose();
});

for (const spokenResume of ["quiet", "verified"] as const) {
  test(`local speech cuts an audible Live reply before any transcript or backend decision (${spokenResume})`, async (t) => {
    const s = setup("auto", undefined, undefined, false, true, spokenResume);
    t.after(() => s.session.dispose());
    s.session.start();
    await flush();
    const first = s.decision("answer");
    s.push(first);
    await flush();
    s.callbacks.onOutput(true);
    s.callbacks.onTranscript("assistant", "The part you heard");
    const revision = s.serverState.revision;
    s.commands.length = 0;

    s.callbacks.onSpeech(true);
    assert.ok(
      s.commands.includes("interrupt"),
      "stop locally, without a server round trip",
    );
    assert.ok(s.commands.includes("mute:true"));
    assert.equal(
      s.commands.includes("prepareOutput"),
      false,
      "drop old audio while the listener speaks",
    );
    s.callbacks.onSpeech(true);
    assert.equal(s.commands.filter((c) => c === "interrupt").length, 1);
    s.callbacks.onInputTranscript?.("Wait, another question");
    s.push({ type: "observing", version: s.serverState.version });
    assert.equal(s.commands.includes("prepareOutput"), false);
    s.callbacks.onTranscript("assistant", " unheard old tail");
    s.callbacks.onOutput(true);
    s.push({
      type: "answered",
      decisionId: first.decisionId,
      answer: "The unheard planned ending",
      sources: [{ text: "A late reference", startMs: 20000 }],
    });
    assert.deepEqual(s.session.getSnapshot().sources, []);
    await flush();
    assert.equal(s.serverState.audibleSource, "none");
    assert.equal(
      s.serverState.revision,
      revision,
      "local audio gating must not stale the new backend decision",
    );
    assert.deepEqual(s.serverState.assistant, {
      decisionId: first.decisionId,
      text: "The part you heard",
      state: "interrupted",
    });
    assert.deepEqual(
      s.session.checkpoint().history.map((t) => t.text),
      [first.text, "The part you heard"],
    );

    s.callbacks.onSpeech(false);
    assert.equal(
      s.commands.at(-1),
      "prepareOutput",
      "retain the next reply's prefix after speech ends",
    );
    s.push(s.decision("ignore"));
    s.callbacks.onOutput(false);
    s.callbacks.onOutputDrained?.();
    s.clock.advance(10000);
    await flush();
    assert.equal(
      s.audio.playing,
      false,
      "ignored input does not resume either audio source",
    );
    s.commands.length = 0;
    const next = { ...s.decision("answer"), text: "The new question" };
    s.push(next);
    await flush();
    assert.ok(s.commands.includes("mute:false"));
    s.callbacks.onOutput(true);
    s.callbacks.onTranscript("assistant", "The new reply from its first word");
    s.clock.advance(250);
    await flush();
    assert.equal(s.serverState.assistant?.state, "speaking");
    assert.deepEqual(
      s.session.checkpoint().history.map((t) => t.text),
      [
        first.text,
        "The part you heard",
        next.text,
        "The new reply from its first word",
      ],
    );
    assert.equal(s.requests.length, 0);
    s.session.dispose();
  });
}

test("cancelling a queued reply before audio starts does not report its transcript as spoken", async () => {
  const s = setup("auto", undefined, undefined, false, true);
  s.session.start();
  await flush();
  s.push(s.decision("answer"));
  await flush();
  s.callbacks.onTranscript("assistant", "A reply that has not started playing");
  s.session.executePlayerCommand({ type: "play" });
  s.clock.advance(0);
  await flush();
  assert.equal(s.serverState.assistant?.state, "interrupted");
  assert.equal(s.serverState.assistant?.text, "");
  s.session.dispose();
});

test("recognition notifications before answer audio starts cannot swallow its first words", async () => {
  const s = setup("auto", undefined, undefined, true, true);
  s.session.start();
  await flush();
  const answer = s.decision("answer");
  s.push(answer);
  await flush();
  assert.equal(s.serverState.assistant?.state, "queued");
  s.commands.length = 0;
  s.callbacks.onSpeech(true);
  s.callbacks.onSpeech(false);
  assert.equal(s.commands.includes("interrupt"), false);
  s.push({ type: "observing", version: s.serverState.version });
  s.push({ type: "classifying", version: s.serverState.version });
  s.callbacks.onTranscript("assistant", "因为这些名目都不合，");
  s.callbacks.onOutput(true);
  s.callbacks.onTranscript("assistant", "作者就用了正传。");
  s.push(s.decision("ignore"));
  s.callbacks.onOutput(false);
  await flush();
  assert.equal(s.serverState.assistant?.state, "quiet");
  assert.equal(
    s.serverState.assistant?.text,
    "因为这些名目都不合，作者就用了正传。",
  );
  assert.equal(
    s.session.getSnapshot().history.at(-1)?.text,
    "因为这些名目都不合，作者就用了正传。",
  );
  assert.equal(s.requests.length, 0);
  s.session.dispose();
});

test("given a pending voice request, arm audio before classification even with debug disabled", async () => {
  const s = setup("auto", undefined, undefined, false, true);
  s.session.start();
  await flush();
  s.commands.length = 0;
  s.callbacks.onSpeech(true);
  assert.ok(s.commands.includes("prepareOutput"));
  assert.equal(
    s.session.getSnapshot().state.mode,
    "playing",
    "buffering alone is not an interruption",
  );
  s.commands.length = 0;
  s.callbacks.onInputTranscript?.("Tell me more");
  assert.ok(s.commands.includes("prepareOutput"));
  s.push(s.decision("wait"));
  assert.equal(s.commands.includes("discardPendingOutput"), false);
  s.push(s.decision("ignore"));
  assert.equal(s.commands.at(-1), "discardPendingOutput");
  s.commands.length = 0;
  s.push({ type: "observing", version: s.serverState.version });
  assert.ok(
    s.commands.includes("prepareOutput"),
    "sideband also arms when local VAD/captions are absent",
  );
  s.push(s.decision("answer"));
  await flush();
  assert.ok(s.commands.includes("mute:false"));
  s.callbacks.onOutput(true);
  s.callbacks.onOutput(false);
  s.commands.length = 0;
  s.callbacks.onSpeech(true);
  s.callbacks.onInputTranscript?.("Honey, dinner?");
  assert.equal(
    s.commands.includes("prepareOutput"),
    false,
    "do not clear/rearm a reply during a thinking gap",
  );
  s.callbacks.onOutput(false);
  s.commands.length = 0;
  s.callbacks.onInputTranscript?.("And then?");
  assert.deepEqual(
    s.commands.filter((c) => c === "mute:true" || c === "prepareOutput"),
    [],
    "a quiet gap is still part of the accepted answer",
  );
  s.session.dispose();
});

test("given a failed buffered reply, the next request can prepare a fresh audio prefix", async () => {
  const s = setup("auto", undefined, undefined, false, true);
  s.session.start();
  await flush();
  s.push(s.decision("answer"));
  await flush();
  s.callbacks.onError(
    "Voice reply buffer exceeded 30 seconds. Please ask again.",
  );
  await flush();
  assert.equal(s.serverState.assistant?.state, "interrupted");
  s.commands.length = 0;
  s.callbacks.onInputTranscript?.("Could you say that again?");
  assert.ok(s.commands.includes("prepareOutput"));
  s.session.dispose();
});

test("given page teardown, notify the server immediately without waiting for a voice close callback", async () => {
  const s = setup("auto", undefined, undefined, false, true);
  s.session.start();
  await flush();
  s.session.stop();
  assert.deepEqual(s.usages, [
    { sessionId: "test-session", seconds: 0, finalized: false, closed: true },
  ]);
  s.session.stop();
  assert.equal(
    s.usages.length,
    1,
    "repeated teardown must not re-send the close request",
  );
  s.session.dispose();
});

test("given an episode switch, close the established session against its original episode", async () => {
  const s = setup("auto", undefined, undefined, false, true);
  s.session.start();
  await flush();
  s.session.load({ ...episode, id: "another" }, null);
  assert.deepEqual(s.usageEpisodes, [episode.id]);
  assert.equal(s.usages[0]?.closed, true);
  s.session.dispose();
});

test("given a confirmed close, later teardown does not request another server close", async () => {
  const s = setup("auto", undefined, undefined, false, true);
  s.session.start();
  await flush();
  s.callbacks.onClose(true, 12, "test-session", true);
  s.session.stop();
  assert.deepEqual(s.usages, [
    { sessionId: "test-session", seconds: 12, finalized: true, closed: true },
  ]);
  s.session.dispose();
});

test("given a control failure during a spoken answer, the microphone and answering state both end", async (t) => {
  const s = setup("auto", undefined, undefined, true, true);
  t.after(() => s.session.dispose());
  s.session.start();
  await flush();
  s.push(s.decision("answer"));
  await flush();
  s.callbacks.onOutput(true);
  s.callbacks.onTranscript("assistant", "The heard prefix");
  assert.equal(s.session.getSnapshot().state.assistantSpeaking, true);
  s.failControl();
  await flush();
  const snapshot = s.session.getSnapshot();
  assert.equal(snapshot.state.assistantSpeaking, false);
  assert.equal(snapshot.state.userSpeaking, false);
  assert.equal(snapshot.state.mode, "reconnecting");
  const diagnostics = await s.session.voiceDiagnostics();
  assert.equal(diagnostics.status, "off");
  assert.equal(diagnostics.spokenReply?.state, "interrupted");
  assert.match(snapshot.error, /time limit reached/);
  assert.equal(s.usages.at(-1)?.closed, true);
  // A late callback from the old connection cannot resurrect the answer.
  s.callbacks.onOutput(true);
  assert.equal(s.session.getSnapshot().state.assistantSpeaking, false);
});

test("given a control failure while listening, the podcast continues at full volume", async (t) => {
  const s = setup("auto", undefined, undefined, false, true);
  t.after(() => s.session.dispose());
  s.session.start();
  await flush();
  s.push({ type: "classifying", version: s.serverState.version });
  s.failControl();
  await flush();
  assert.equal(s.audio.playing, true);
  assert.equal(s.audio.level, 1);
  assert.equal(s.session.getSnapshot().state.mode, "playing");
});

test("given a control failure after an explicit resume, the pending resume still completes", async (t) => {
  const s = setup("auto", undefined, undefined, false, true);
  t.after(() => s.session.dispose());
  s.session.start();
  await flush();
  s.push(s.decision("answer"));
  await flush();
  s.push(s.decision("resume"));
  s.failControl();
  await flush();
  s.clock.advance(0);
  await flush();
  assert.equal(s.audio.playing, true);
  assert.equal(s.session.getSnapshot().state.mode, "playing");
});

test("a Live progress sentence and a long quiet gap do not finish the answer or resume the podcast", async (t) => {
  const s = setup("auto", undefined, undefined, true, true);
  t.after(() => s.session.dispose());
  s.session.start();
  await flush();
  s.push(s.decision("answer"));
  await flush();
  s.callbacks.onOutput(true);
  s.callbacks.onTranscript("assistant", "Let me check that.");
  s.callbacks.onOutput(false);
  s.clock.advance(10000);
  await flush();
  assert.equal(s.audio.playing, false);
  assert.equal(s.session.getSnapshot().resumeSeconds, null);
  assert.equal(s.serverState.assistant?.state, "quiet");
  // Background input must not close the answer window during the pause.
  s.push({ type: "observing", version: s.serverState.version });
  s.push({ type: "classifying", version: s.serverState.version });
  s.push(s.decision("ignore"));
  s.clock.advance(10000);
  await flush();
  assert.equal(s.audio.playing, false);
  s.callbacks.onOutput(true);
  s.callbacks.onTranscript("assistant", " Here is what I found.");
  s.callbacks.onOutput(false);
  await flush();
  assert.equal(
    s.serverState.assistant?.text,
    "Let me check that. Here is what I found.",
  );
  assert.equal(
    s.session.getSnapshot().history.at(-1)?.text,
    "Let me check that. Here is what I found.",
  );
  assert.equal(s.serverState.assistant?.state, "quiet");
  s.push(s.decision("resume"));
  s.clock.advance(0);
  await flush();
  assert.equal(s.audio.playing, true);
  assert.equal(s.serverState.assistant?.state, "interrupted");
});

test("new conversation clears saved context atomically and cancels old work without moving the playhead", async (t) => {
  const s = setup("off");
  t.after(() => s.session.dispose());
  s.session.start();
  s.session.submitQuestion("Old question");
  s.session.setQuestion("Old draft");
  s.session.setError("问题或对话过长，请开始新的对话");
  const before = s.session.checkpoint();
  const checkpoints: ReturnType<typeof s.session.checkpoint>[] = [];
  const unsubscribe = s.session.subscribe(() =>
    checkpoints.push(s.session.checkpoint()),
  );
  await s.session.newConversation();
  unsubscribe();
  assert.equal(s.requests[0].signal.aborted, true);
  assert.ok(checkpoints.length > 0);
  assert.ok(checkpoints.every((cp) => cp.history.length === 0));
  assert.deepEqual(s.session.checkpoint(), { ...before, history: [] });
  assert.equal(s.session.getSnapshot().question, "");
  assert.equal(s.session.getSnapshot().error, "");
  assert.equal(s.session.getSnapshot().busy, false);
  assert.equal(s.audio.playing, false);
  assert.equal(s.audio.positionMs, 31000);
  assert.equal(s.voiceCount, 0);
  s.answer(0, "Late old answer");
  await flush();
  assert.deepEqual(s.session.getSnapshot().history, []);
  s.session.submitQuestion("Fresh question");
  assert.deepEqual(
    s.requests[1].data.history.map(({ role, text }) => ({ role, text })),
    [{ role: "user", text: "Fresh question" }],
  );
});

test("new conversation replaces the active Live session with empty history and ignores stale callbacks", async (t) => {
  const s = setup(
    "auto",
    undefined,
    { playbackRate: 1.2, volume: 0.4 },
    true,
    true,
  );
  t.after(() => s.session.dispose());
  s.session.start();
  await flush();
  s.push(s.decision("answer"));
  await flush();
  s.callbacks.onOutput(true);
  s.callbacks.onTranscript("assistant", "Old voice context");
  s.callbacks.onOutput(false);
  const previous = s.callbacks;
  const checkpoint = s.session.checkpoint();
  await s.session.newConversation();
  await flush();
  assert.equal(s.voiceCount, 2);
  assert.equal(s.liveRequests.length, 2);
  assert.deepEqual(s.liveRequests[1].history, []);
  assert.equal(s.liveRequests[1].control?.player.assistant, undefined);
  assert.equal(s.usages[0]?.closed, true);
  assert.deepEqual(s.session.checkpoint(), { ...checkpoint, history: [] });
  assert.equal(s.audio.playing, false);
  assert.equal(s.audio.config.playbackRate, 1.2);
  assert.equal(s.audio.config.volume, 0.4);
  previous.onOutput(true);
  previous.onTranscript("assistant", "Late old voice");
  previous.onError("Old error");
  assert.equal(s.session.getSnapshot().state.assistantSpeaking, false);
  assert.deepEqual(s.session.getSnapshot().history, []);
  assert.equal(s.session.getSnapshot().error, "");
  s.clock.advance(10000);
  await flush();
  assert.equal(s.audio.playing, false);
});

test("new conversation preserves playing audio and never opens a microphone that was off", async (t) => {
  const s = setup("off");
  t.after(() => s.session.dispose());
  s.session.load(episode, {
    positionMs: 31000,
    history: [{ role: "user", text: "Old saved history" }],
  });
  s.session.metadataLoaded();
  s.session.start();
  await flush();
  const plays = s.audio.plays;
  await s.session.newConversation();
  assert.equal(s.audio.playing, true);
  assert.equal(s.audio.plays, plays);
  assert.equal(s.audio.positionMs, 31000);
  assert.equal(s.session.getSnapshot().state.mode, "playing");
  assert.deepEqual(s.session.checkpoint().history, []);
  assert.equal(s.voiceCount, 0);
});

async function mobileSpoken() {
  const s = setup("auto", undefined, undefined, false, true, "verified");
  s.session.start();
  await flush();
  const decisionId = crypto.randomUUID();
  s.push({
    type: "engage",
    version: s.serverState.version,
    revision: s.serverState.revision,
    decisionId,
    player: { ...s.serverState, source: "voice", turnId: "mobile-turn" },
    text: "What is a biography?",
  });
  await flush();
  const answer = (text = "A biography is a life story.") => {
    s.push({ type: "answered", decisionId, answer: text, sources: [] });
  };
  const hear = (text = "A biography is a life story.", drain = true) => {
    s.callbacks.onOutput(true);
    s.callbacks.onTranscript("assistant", text);
    s.callbacks.onOutput(false);
    if (drain) s.callbacks.onOutputDrained?.();
  };
  return { ...s, answer, hear, decisionId };
}

for (const metadataLast of [false, true])
  test(`a corroborated spoken formulation keeps one mobile turn and waits for native drain (${metadataLast})`, async (t) => {
    const s = await mobileSpoken();
    t.after(() => s.session.dispose());
    const anchor = s.session.checkpoint().resumeMs;
    s.answer("A biography is a life story.");
    const spoken = "A biography tells the story of another person's life.";
    s.hear(spoken, false);
    const confirm = () => s.push({ type: "answered", decisionId: s.decisionId, answer: spoken, sources: [], final: true });
    if (!metadataLast) confirm();
    s.clock.advance(10000);
    await flush();
    assert.equal(s.audio.playing, false);
    assert.equal(s.session.getSnapshot().resumeSeconds, null, "metadata never substitutes for native drain");
    s.callbacks.onOutputDrained?.();
    if (metadataLast) {
      assert.equal(s.session.getSnapshot().resumeSeconds, null, "unmatched speech cannot resume");
      confirm();
    }
    assert.equal(s.session.getSnapshot().resumeSeconds, 3);
    assert.equal(s.session.checkpoint().resumeMs, anchor);
    assert.deepEqual(s.session.checkpoint().history.map(({ role, text }) => [role, text]), [
      ["user", "What is a biography?"], ["assistant", spoken],
    ]);
    s.clock.advance(3000);
    await flush();
    assert.equal(s.audio.playing, true);
    assert.equal(s.audio.positionMs, anchor);
    assert.equal(s.session.getSnapshot().listeningActive, true);
    confirm();
    s.callbacks.onOutput(true);
    s.callbacks.onTranscript("assistant", "A late duplicate must stay muted.");
    assert.equal(s.session.checkpoint().history.length, 2);
    assert.equal(s.session.getSnapshot().state.assistantSpeaking, false);
  });

test("mobile reports a verified answer as finished and closes its audio window before a late replay", async (t) => {
  for (const metadataLast of [false, true]) {
    const s = await mobileSpoken();
    t.after(() => s.session.dispose());
    if (!metadataLast) s.answer();
    s.hear();
    if (metadataLast) s.answer();
    await flush();
    assert.equal(s.updates.at(-1)?.player.assistant?.state, "finished");
    assert.equal(
      s.updates.at(-1)?.player.assistant?.text,
      "A biography is a life story.",
    );
    const history = s.session.checkpoint().history;
    s.callbacks.onOutput(true);
    s.callbacks.onTranscript("assistant", "Unrequested repeated answer.");
    s.callbacks.onOutput(false);
    s.callbacks.onOutputDrained?.();
    assert.deepEqual(s.session.checkpoint().history, history);
    assert.equal(s.session.getSnapshot().state.assistantSpeaking, false);
    s.clock.advance(3000);
    await flush();
    assert.equal(s.audio.playing, true);
    assert.equal(s.session.getSnapshot().listeningActive, true);
  }
});

test("native interruption cancels a mobile answer and never resumes or reopens the microphone on late drain", async (t) => {
  const s = await mobileSpoken();
  t.after(() => s.session.dispose());
  const anchor = s.session.checkpoint().resumeMs;
  const previous = s.callbacks;
  s.answer();
  previous.onOutput(true);
  previous.onTranscript("assistant", "A biography");
  previous.onInterruption?.();
  previous.onOutput(false);
  previous.onOutputDrained?.();
  s.clock.advance(30000);
  await flush();
  assert.equal(s.audio.playing, false);
  assert.equal(s.session.getSnapshot().state.mode, "paused");
  assert.equal(s.session.checkpoint().resumeMs, anchor);
  assert.equal(s.session.getSnapshot().listeningActive, false);
  assert.equal(s.session.getSnapshot().resumeSeconds, null);
});

test("mobile lock-screen playback after background never reopens continuous capture", async (t) => {
  const s = setup("auto", undefined, undefined, false, true, "verified");
  t.after(() => s.session.dispose());
  s.session.start();
  await flush();
  assert.equal(s.voiceCount, 1);
  s.session.background();
  assert.equal(s.audio.playing, true, "native podcast keeps playing");
  assert.equal(s.session.getSnapshot().listeningMode, "manual");
  assert.equal(s.session.getSnapshot().liveStatus, "off");
  s.session.stop(); // lock-screen pause
  s.session.start(); // lock-screen play
  await flush();
  assert.equal(s.audio.playing, true);
  assert.equal(s.voiceCount, 1);
  assert.equal(s.session.getSnapshot().liveStatus, "off");
  await s.session.enableContinuous(); // explicit foreground consent
  await flush();
  assert.equal(s.voiceCount, 2);
  assert.equal(s.session.getSnapshot().listeningActive, true);
});

test("backgrounding a mobile answer preserves its anchor for a microphone-free system resume", async (t) => {
  const s = await mobileSpoken();
  t.after(() => s.session.dispose());
  const anchor = s.session.checkpoint().resumeMs;
  s.session.background();
  assert.equal(s.audio.playing, false);
  s.session.start();
  s.clock.advance(1);
  await flush();
  assert.equal(s.audio.playing, true);
  assert.equal(s.audio.positionMs, anchor);
  assert.equal(s.session.getSnapshot().liveStatus, "off");
  assert.equal(s.voiceCount, 1);
});

test("mobile resumes only after the final answer's native playout and follow-up window", async (t) => {
  const s = await mobileSpoken();
  t.after(() => s.session.dispose());
  s.hear("Let me check that.");
  s.clock.advance(15000);
  assert.equal(s.audio.playing, false);
  s.answer();
  s.hear(" A biography is a life story.", false);
  s.clock.advance(15000);
  assert.equal(s.audio.playing, false, "captions cannot outrun native audio");
  s.callbacks.onOutputDrained?.();
  assert.equal(s.session.getSnapshot().resumeSeconds, 3);
  s.clock.advance(2999);
  assert.equal(s.audio.playing, false);
  s.clock.advance(1);
  await flush();
  assert.equal(s.audio.playing, true);
  assert.equal(s.audio.positionMs, 20000, "resume from the semantic anchor");
  assert.equal(
    s.session.getSnapshot().listeningActive,
    true,
    "microphone stays enabled",
  );
});

test("mobile's unconfirmed or paraphrased answer stays paused with a visible reason", async (t) => {
  const s = await mobileSpoken();
  t.after(() => s.session.dispose());
  s.answer();
  s.hear("A biography tells someone's story.");
  s.clock.advance(10000);
  await flush();
  assert.equal(s.audio.playing, false);
  assert.equal(s.session.getSnapshot().resumeNeedsConfirmation, true);
  assert.equal(s.session.getSnapshot().resumeSeconds, null);
});

test("mobile long answers wait at least eight seconds, including when metadata arrives last", async (t) => {
  const s = await mobileSpoken();
  t.after(() => s.session.dispose());
  const long = "A biography explains a person's life in context. ".repeat(9);
  s.hear(long);
  s.answer(long);
  assert.equal(s.session.getSnapshot().resumeSeconds, 8);
  s.clock.advance(7999);
  assert.equal(s.audio.playing, false);
  s.clock.advance(1);
  await flush();
  assert.equal(s.audio.playing, true);
});

test("mobile manual hold persists after a verified spoken answer and late completion", async (t) => {
  const s = await mobileSpoken();
  t.after(() => s.session.dispose());
  s.session.holdResume();
  s.answer();
  s.hear();
  s.clock.advance(30000);
  await flush();
  assert.equal(s.audio.playing, false);
  assert.equal(s.session.getSnapshot().resumeHeld, true);
});

test("mobile draft and a newly admitted reply cancel a pending automatic continuation", async (t) => {
  const s = await mobileSpoken();
  t.after(() => s.session.dispose());
  s.answer();
  s.hear();
  s.clock.advance(1000);
  const player = s.updates.at(-1)!.player;
  const decisionId = "new-follow-up";
  s.push({
    type: "engage",
    version: player.version,
    revision: player.revision,
    decisionId,
    player: { ...player, source: "voice", turnId: "new-input" },
    text: "And an autobiography?",
  });
  await flush();
  s.callbacks.onOutput(true);
  s.clock.advance(10000);
  assert.equal(s.audio.playing, false);
  s.push({
    type: "answered",
    decisionId,
    answer: "The author tells their own life story.",
    sources: [],
  });
  s.callbacks.onTranscript(
    "assistant",
    "The author tells their own life story.",
  );
  s.callbacks.onOutput(false);
  s.callbacks.onOutputDrained?.();
  s.session.setQuestion("A follow-up I am typing");
  s.clock.advance(10000);
  await flush();
  assert.equal(s.audio.playing, false);
  assert.equal(s.session.getSnapshot().resumeSeconds, null);
});

test("mobile typed questions stream, clear the composer and speak through an already-connected Live session", async (t) => {
  const s = setup("auto", undefined, undefined, false, true, "verified");
  t.after(() => s.session.dispose());
  await s.session.enableContinuous();
  await flush();
  s.session.setQuestion("Explain this sentence");
  s.session.submitQuestion(s.session.getSnapshot().question, true);
  assert.equal(s.session.getSnapshot().question, "");
  assert.equal(s.requests.length, 1);
  s.requests[0].preview!("A streamed");
  assert.equal(s.session.getSnapshot().answerPreview, "A streamed");
  s.requests[0].resolve({
    action: "answer",
    revision: s.requests[0].data.revision,
    answer: "A streamed answer to the typed question.",
    sources: [],
    tools: [],
  });
  await flush();
  assert.ok(
    s.commands.includes("commentary:A streamed answer to the typed question."),
  );
  s.callbacks.onOutput(true);
  s.callbacks.onTranscript(
    "assistant",
    "A streamed answer to the typed question.",
  );
  s.callbacks.onOutput(false);
  s.callbacks.onOutputDrained?.();
  await flush();
  assert.deepEqual(
    s.session.checkpoint().history.map(({ role, text }) => [role, text]),
    [
      ["user", "Explain this sentence"],
      ["assistant", "A streamed answer to the typed question."],
    ],
  );
  assert.equal(s.session.getSnapshot().resumeSeconds, 3);
  assert.equal(
    s.liveRequests.length,
    1,
    "the typed question reuses the existing connection",
  );
});

test("mobile buffers admitted audio until the native podcast fade is complete", async (t) => {
  const s = setup("auto", undefined, undefined, false, true, "verified");
  t.after(() => s.session.dispose());
  s.session.start();
  await flush();
  let finish!: () => void;
  s.audio.settle = async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    s.audio.playing = false;
  };
  s.commands.length = 0;
  s.push({
    type: "engage",
    version: s.serverState.version,
    revision: s.serverState.revision,
    decisionId: "fade-turn",
    player: { ...s.serverState, source: "voice", turnId: "fade-input" },
    text: "Explain that",
  });
  await flush();
  assert.equal(s.audio.playing, true);
  assert.equal(s.commands.includes("mute:false"), false);
  finish();
  await flush();
  assert.equal(s.audio.playing, false);
  assert.ok(s.commands.includes("mute:false"));
});

test("native play at the end of an episode restarts it from the beginning", async (t) => {
  const s = setup("off", undefined, undefined, false, false, "verified");
  t.after(() => s.session.dispose());
  s.session.load(episode, { positionMs: episode.durationMs - 2, history: [] });
  s.session.metadataLoaded();
  s.session.start();
  await flush();
  assert.equal(s.audio.positionMs, 0);
  assert.equal(s.audio.playing, true);
});

function engaged(s: ReturnType<typeof setup>) {
  const decisionId = crypto.randomUUID();
  s.push({
    type: "engage",
    version: s.serverState.version,
    revision: s.serverState.revision,
    decisionId,
    player: { ...s.serverState, source: "voice", turnId: "server-turn" },
    text: "What is a biography?",
  });
  return decisionId;
}

test("a delegated answer resumes the podcast after a quiet follow-up window, never before it is complete", async (t) => {
  const s = setup("auto", undefined, undefined, false, true);
  t.after(() => s.session.dispose());
  s.session.start();
  await flush();
  const decisionId = engaged(s);
  await flush();
  // A lookup pause: the voice spoke, went quiet, and the backend is not done.
  s.callbacks.onOutput(true);
  s.callbacks.onTranscript("assistant", "Let me check that.");
  s.callbacks.onOutput(false);
  assert.equal(s.session.getSnapshot().resumeSeconds, null);
  s.clock.advance(10000);
  await flush();
  assert.equal(
    s.audio.playing,
    false,
    "silence before `answered` is not the end",
  );
  // Text and a tool call in one response: more of the reply is still coming.
  s.push({
    type: "answered",
    decisionId,
    answer: "One moment.",
    sources: [],
    final: false,
  });
  await flush();
  s.clock.advance(10000);
  await flush();
  assert.equal(
    s.audio.playing,
    false,
    "a non-final answer keeps the window shut",
  );
  s.push({
    type: "answered",
    decisionId,
    answer: "A biography is a life story.",
    sources: [],
  });
  await flush();
  s.clock.advance(10000);
  await flush();
  assert.equal(
    s.audio.playing,
    false,
    "the answer text is ready but has not been spoken yet",
  );
  s.callbacks.onOutput(true);
  s.callbacks.onTranscript("assistant", " A biography is a life story.");
  await flush();
  s.clock.advance(10000);
  await flush();
  assert.equal(
    s.audio.playing,
    false,
    "never while the answer is being spoken",
  );
  s.callbacks.onOutput(false);
  assert.equal(s.session.getSnapshot().resumeSeconds, 3);
  s.clock.advance(3000);
  await flush();
  assert.equal(s.audio.playing, true);
});

test("speech or a held window stops a delegated answer from resuming the podcast", async (t) => {
  const s = setup("auto", undefined, undefined, false, true);
  t.after(() => s.session.dispose());
  s.session.start();
  await flush();
  const decisionId = engaged(s);
  await flush();
  s.push({
    type: "answered",
    decisionId,
    answer: "A biography is a life story.",
    sources: [],
  });
  s.callbacks.onOutput(true);
  s.callbacks.onOutput(false);
  assert.equal(s.session.getSnapshot().resumeSeconds, 3);
  s.callbacks.onSpeech(true);
  s.clock.advance(10000);
  await flush();
  assert.equal(s.audio.playing, false, "someone is speaking");
  s.callbacks.onSpeech(false);
  // The server decides what that speech was; background talk reopens the window.
  s.push(s.decision("ignore"));
  await flush();
  assert.equal(
    s.session.getSnapshot().resumeSeconds,
    3,
    "the window restarts after speech",
  );
  s.session.holdResume();
  s.clock.advance(10000);
  await flush();
  assert.equal(s.audio.playing, false, "the listener asked to stay paused");
});

test("a barge-in holds the podcast only until the listener's next answered question", async (t) => {
  const s = setup("auto", undefined, undefined, false, true);
  t.after(() => s.session.dispose());
  s.session.start();
  await flush();
  const first = engaged(s);
  await flush();
  s.push({
    type: "answered",
    decisionId: first,
    answer: "A long first answer.",
    sources: [],
  });
  s.callbacks.onOutput(true);
  s.callbacks.onTranscript("assistant", "A long first");
  // The listener talks over the reply; the backend finds nothing addressed to it.
  s.callbacks.onSpeech(true);
  s.callbacks.onOutput(false);
  s.callbacks.onSpeech(false);
  s.push(s.decision("ignore"));
  s.clock.advance(10000);
  await flush();
  assert.equal(s.audio.playing, false, "an ignored barge-in stays quiet");
  assert.equal(s.session.getSnapshot().resumeHeld, true);
  // Their next question is answered in full: that answer resumes the podcast.
  const second = engaged(s);
  await flush();
  s.push({
    type: "answered",
    decisionId: second,
    answer: "The second answer.",
    sources: [],
  });
  s.callbacks.onOutput(true);
  s.callbacks.onTranscript("assistant", "The second answer.");
  s.callbacks.onOutput(false);
  assert.equal(s.session.getSnapshot().resumeSeconds, 3);
  s.clock.advance(3000);
  await flush();
  assert.equal(s.audio.playing, true);
});

test("mobile keeps speech ducking and its three-second default when server defaults change", async (t) => {
  const s = setup(
    "auto",
    undefined,
    undefined,
    false,
    true,
    "verified",
    {
      speechYield: "duck",
      followupMs: 3000,
    },
  );
  t.after(() => s.session.dispose());
  s.session.configure({
    liveConfigured: true,
    microphone: { threshold: 0.025, minSpeechMs: 120, silenceMs: 650 },
    voiceLifecycle: {
      preRollMs: 750,
      graceMs: 5000,
      idleCloseMs: 60000,
      autoResumeMs: 2000,
    },
  });
  assert.equal(s.session.getSnapshot().followupMs, 3000);
  s.session.start();
  await flush();
  s.callbacks.onSpeech(true);
  assert.equal(s.audio.playing, true);
  assert.equal(s.audio.level, 0.15);
  s.push({ type: "classifying", version: s.serverState.version });
  assert.equal(s.audio.level, 0.15);
  s.callbacks.onSpeech(false);
  s.push(s.decision("ignore"));
  await flush();
  assert.equal(s.audio.playing, true);
  assert.equal(s.audio.level, 1);
});

test("mobile cannot finish on a drained progress answer when the backend says tools follow", async (t) => {
  const s = setup("auto", undefined, undefined, false, true, "verified");
  t.after(() => s.session.dispose());
  s.session.start();
  await flush();
  const decisionId = engaged(s);
  await flush();
  s.push({
    type: "answered",
    decisionId,
    answer: "One moment.",
    sources: [],
    final: false,
  });
  s.callbacks.onOutput(true);
  s.callbacks.onTranscript("assistant", "One moment.");
  s.callbacks.onOutput(false);
  s.callbacks.onOutputDrained?.();
  s.clock.advance(10000);
  await flush();
  assert.equal(s.audio.playing, false);
  assert.equal(s.session.getSnapshot().resumeSeconds, null);
  assert.notEqual(s.updates.at(-1)?.player.assistant?.state, "finished");
  s.push({
    type: "answered",
    decisionId,
    answer: "A biography is a life story.",
    sources: [],
    final: true,
  });
  s.callbacks.onOutput(true);
  s.callbacks.onTranscript("assistant", " A biography is a life story.");
  s.callbacks.onOutput(false);
  s.callbacks.onOutputDrained?.();
  assert.equal(s.session.getSnapshot().resumeSeconds, 3);
  s.clock.advance(3000);
  await flush();
  assert.equal(s.audio.playing, true);
});

for (const explicitHold of [false, true]) {
  test(`mobile's next answered question lifts a barge-in hold but preserves a user hold (${explicitHold})`, async (t) => {
    const s = setup("auto", undefined, undefined, false, true, "verified");
    t.after(() => s.session.dispose());
    s.session.start();
    await flush();
    const first = engaged(s);
    await flush();
    s.push({
      type: "answered",
      decisionId: first,
      answer: "The full old answer.",
      sources: [],
    });
    s.callbacks.onOutput(true);
    s.callbacks.onTranscript("assistant", "The full");
    s.callbacks.onSpeech(true);
    s.callbacks.onOutput(false);
    s.callbacks.onSpeech(false);
    s.push(s.decision("ignore"));
    s.clock.advance(10000);
    await flush();
    assert.equal(s.audio.playing, false);
    if (explicitHold) s.session.holdResume();
    const next = engaged(s);
    await flush();
    s.push({
      type: "answered",
      decisionId: next,
      answer: "The next answer.",
      sources: [],
    });
    s.callbacks.onOutput(true);
    s.callbacks.onTranscript("assistant", "The next answer.");
    s.callbacks.onOutput(false);
    s.callbacks.onOutputDrained?.();
    assert.equal(s.session.getSnapshot().resumeHeld, explicitHold);
    assert.equal(
      s.session.getSnapshot().resumeSeconds,
      explicitHold ? null : 3,
    );
    s.clock.advance(3000);
    await flush();
    assert.equal(s.audio.playing, !explicitHold);
  });
}

test("a noise after the answer that never reaches a decision cannot strand the podcast", async (t) => {
  const s = setup("auto", undefined, undefined, false, true);
  t.after(() => s.session.dispose());
  s.session.start();
  await flush();
  const decisionId = engaged(s);
  await flush();
  s.push({
    type: "answered",
    decisionId,
    answer: "A biography is a life story.",
    sources: [],
  });
  s.callbacks.onOutput(true);
  s.callbacks.onOutput(false);
  assert.equal(s.session.getSnapshot().resumeSeconds, 3);
  // A cough: detected locally, never transcribed, so the backend decides nothing.
  s.callbacks.onSpeech(true);
  assert.equal(s.session.getSnapshot().resumeSeconds, null);
  assert.deepEqual((await s.session.voiceDiagnostics()).autoResume.blockedBy, [
    "speech detected",
    "input awaiting a decision",
  ]);
  s.callbacks.onSpeech(false);
  s.clock.advance(pendingDecisionMs - 1);
  await flush();
  assert.equal(s.audio.playing, false);
  s.clock.advance(1);
  assert.equal(s.session.getSnapshot().resumeSeconds, 3, "the window reopens");
  assert.deepEqual(
    (await s.session.voiceDiagnostics()).autoResume.blockedBy,
    [],
  );
  s.clock.advance(3000);
  await flush();
  assert.equal(s.audio.playing, true);
});

for (const drained of [false, true]) {
  test(`mobile noise expiry never bypasses native completion (${drained})`, async (t) => {
    const s = await mobileSpoken();
    t.after(() => s.session.dispose());
    s.answer();
    s.hear(undefined, drained);
    s.callbacks.onSpeech(true);
    assert.equal(s.session.getSnapshot().resumeSeconds, null);
    s.callbacks.onSpeech(false);
    s.clock.advance(pendingDecisionMs);
    await flush();
    assert.equal(s.session.getSnapshot().resumeSeconds, drained ? 3 : null);
    const blockers = (await s.session.voiceDiagnostics()).autoResume.blockedBy;
    assert.equal(
      blockers.includes("native answer playback unconfirmed"),
      !drained,
    );
    s.clock.advance(3000);
    await flush();
    assert.equal(s.audio.playing, drained);
  });
}
