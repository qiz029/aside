import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ListeningSession,
  type ListeningMode,
  type VoicePort,
} from "../frontend/src/listening-session.js";
import type { RuntimeClock } from "../frontend/src/runtime-clock.js";
import type { VoiceCallbacks } from "../frontend/src/on-demand-voice.js";
import type { PlayerBackend } from "../frontend/src/player-api.js";
import type {
  QuestionRequest,
  QuestionResult,
  QuestionPhase,
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
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
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
    config: createPlayerConfig(),
    configure(config: PlayerConfig) {
      this.config = config;
    },
  };
  const requests: {
    data: QuestionRequest;
    signal: AbortSignal;
    progress: (phase: QuestionPhase) => void;
    resolve: (result: QuestionResult) => void;
  }[] = [];
  const commands: string[] = [];
  let callbacks!: VoiceCallbacks;
  let enabled = false,
    captures = 0,
    warm = false,
    cold = true;
  let voiceCount = 0;
  const backend: PlayerBackend = {
    question(_id, data, signal, progress) {
      return new Promise((resolve) =>
        requests.push({ data, signal, progress, resolve }),
      );
    },
    async live() {
      throw Error("Unexpected live negotiation");
    },
    async transcribe() {
      throw Error("Unexpected transcription");
    },
    async usage() {},
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
    voiceFactory(_mic, _config, cb) {
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
  audio.positionMs = 31000;
  return {
    clock,
    audio,
    session,
    requests,
    commands,
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
  s.clock.advance(120);
  await flush();
  trace = (await s.session.voiceDiagnostics()).recognition!;
  assert.equal(trace.conversationInput, "Wait, wait!");
  assert.equal(trace.submittedText, s.requests[0].data.history.at(-1)?.text);
  assert.equal(trace.requestPending, true);
  assert.equal(trace.shortPauseCandidate, true);
  assert.deepEqual(s.session.checkpoint().history, []);
  assert.ok(s.session.getSnapshot().events.every((event) => !event.includes("Wait, wait!")));
  s.session.stop();
  assert.equal((await s.session.voiceDiagnostics()).recognition?.liveInputText, "Wait, wait!");
  s.session.dispose();
});

test("debug recognition is bounded, preserves whitespace and clears on a new connection or episode", async () => {
  const s = setup("auto", undefined, undefined, true);
  s.session.start();
  await flush();
  for (const text of ["Hello", " ", "there!"]) s.callbacks.onInputTranscript?.(text);
  assert.equal((await s.session.voiceDiagnostics()).recognition?.liveInputText, "Hello there!");
  for (let i = 0; i < 40; i++) s.callbacks.onInputTranscript?.("x".repeat(600));
  const trace = (await s.session.voiceDiagnostics()).recognition!;
  assert.equal(trace.liveInputText.length, 4000);
  assert.equal(trace.recentDeltas.length, 30);
  assert.ok(trace.recentDeltas.every((delta) => delta.text.length === 500));
  const old = s.callbacks;
  s.session.stop();
  old.onInputTranscript?.("stale");
  assert.equal((await s.session.voiceDiagnostics()).recognition?.liveInputText, trace.liveInputText);
  s.session.start();
  await flush();
  assert.equal((await s.session.voiceDiagnostics()).recognition?.liveInputText, "");
  s.callbacks.onInputTranscript?.("new episode must not inherit this");
  s.session.load(episode, null);
  assert.equal((await s.session.voiceDiagnostics()).recognition?.liveInputText, "");
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
test("voice progress is excluded from latency and countdown starts after the answer audio", async () => {
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

test("repeated wait reaches the backend without delegation and does not starve its pending decision", async () => {
  const s = setup("auto");
  s.session.start();
  await flush();
  s.warm();
  s.callbacks.onSpeech(true);
  s.callbacks.onTranscript("user", "Wait, wait");
  s.clock.advance(120);
  assert.equal(s.requests.length, 1);
  s.callbacks.onSpeech(false);
  s.callbacks.onSpeech(true);
  s.callbacks.onTranscript("user", ", wait!");
  s.callbacks.onDelegation("late-delegation");
  s.clock.advance(500);
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].signal.aborted, false);
  remoteResult(s, 0, [{ type: "pause" }]);
  await flush();
  assert.equal(s.audio.playing, false);
  s.session.dispose();
});

test("short-command fallback still lets the backend ignore speech to somebody else", async () => {
  const s = setup("auto");
  s.session.start();
  await flush();
  s.warm();
  s.callbacks.onSpeech(true);
  s.callbacks.onTranscript("user", "Hold on");
  s.clock.advance(120);
  assert.equal(s.requests.length, 1);
  s.requests[0].resolve({
    revision: s.requests[0].data.revision,
    action: "ignore",
    answer: "",
    tools: [],
    sources: [],
  });
  await flush();
  assert.equal(s.audio.playing, true);
  assert.equal(s.session.getSnapshot().history.length, 0);
  s.session.dispose();
});

test("prefixed English controls reach classification without delegation or speech-end", async () => {
  for (const text of ["Hey, stop the podcast please!", "Excuse me—could you pause?", "你好。Stop!", "Could you turn the volume down?"]) {
    const s = setup("auto");
    s.session.start();
    await flush();
    s.warm();
    s.callbacks.onSpeech(true);
    s.callbacks.onTranscript("user", text);
    s.clock.advance(120);
    assert.equal(s.requests.length, 1, text);
    assert.equal(s.requests[0].data.history.at(-1)?.text, text);
    assert.equal(s.audio.playing, true, "candidate selection must not pause audio");
    remoteResult(s, 0, [{ type: "pause" }]);
    await flush();
    assert.equal(s.audio.playing, false);
    s.session.dispose();
  }
});

test("standalone whitespace deltas preserve word boundaries for classification", async () => {
  const s = setup("auto");
  s.session.start();
  await flush();
  s.warm();
  for (const delta of ["Hey", " ", "stop", " ", "please"])
    s.callbacks.onTranscript("user", delta);
  s.clock.advance(120);
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].data.history.at(-1)?.text, "Hey stop please");
  assert.equal(s.audio.playing, true);
  s.callbacks.onTranscript("user", " ");
  s.clock.advance(500);
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].signal.aborted, false);
  s.session.dispose();
});

test("fallback candidates containing negations or bystander commands remain subject to backend rejection", async () => {
  for (const text of ["Do not stop the podcast", "Honey, stop moving the chair", "He said 'pause the podcast' in that story"]) {
    const s = setup("auto");
    s.session.start();
    await flush();
    s.warm();
    s.callbacks.onTranscript("user", text);
    s.clock.advance(120);
    assert.equal(s.requests.length, 1, text);
    assert.equal(s.audio.playing, true);
    s.requests[0].resolve({ revision: s.requests[0].data.revision, action: "ignore", answer: "", tools: [], sources: [] });
    await flush();
    assert.equal(s.audio.playing, true);
    assert.equal(s.audio.config.volume, 1);
    assert.deepEqual(s.session.checkpoint().history, []);
    s.session.dispose();
  }
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
