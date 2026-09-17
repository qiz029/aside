import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OnDemandVoice,
  type CloudPort,
  type VoiceCallbacks,
  type VoiceDependencies,
} from "../frontend/src/on-demand-voice.js";
import type { LiveCallbacks } from "../frontend/src/live.js";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function setup(manual = false, continuous = false) {
  let speech!: (a: boolean) => void;
  let callbacks!: LiveCallbacks;
  let creates = 0,
    closed = 0,
    micStopped = 0,
    captures = 0;
  let resolveConnect!: () => void;
  let resolveText!: (text: string) => void;
  let signal: AbortSignal | undefined;
  const statuses: string[] = [],
    questions: string[] = [],
    events: string[] = [];
  const configs = { graceMs: 20, idleCloseMs: 50, preRollMs: 750 };
  const clouds: CloudPort[] = [];
  const cb: VoiceCallbacks = {
    onReady() {
      events.push("ready");
    },
    onSpeech(a) {
      events.push(a ? "speech" : "end");
    },
    onOutput() {},
    onTranscript() {},
    onDelegation() {},
    onError(e) {
      events.push("error:" + e);
    },
    onFirstQuestion(t) {
      questions.push(t);
    },
    onStatus(s) {
      statuses.push(s);
    },
    onClose(final, seconds, id, intentional) {
      events.push(`closed:${intentional}:${id}`);
    },
  };
  const deps: VoiceDependencies = {
    microphone: (onSpeech) => {
      speech = onSpeech;
      return {
        stream: {} as MediaStream,
        async start() {},
        begin() {
          captures++;
        },
        snapshot() {
          return new Blob(["wav"]);
        },
        discard() {},
        stop() {
          micStopped++;
        },
      };
    },
    cloud: (cb) => {
      callbacks = cb;
      let id = "";
      const c: CloudPort = {
        async connect(_stream, create) {
          creates++;
          id = (await create("offer")).session.id;
          await new Promise<void>((resolve) => (resolveConnect = resolve));
          cb.onReady();
        },
        append(t, c) {
          events.push(t + ":" + c);
        },
        mute() {},
        prepareOutput() {
          events.push("prepareOutput");
        },
        discardPendingOutput() {
          events.push("discardPendingOutput");
        },
        input(v) {
          events.push("input:" + v);
        },
        interrupt() {},
        async close() {
          closed++;
          cb.onClose(true, 3);
        },
      };
      clouds.push(c);
      return c;
    },
    async create() {
      return {
        session: { id: "session-" + creates },
        transport: { sdp: "answer" },
      };
    },
    transcribe: (_blob, s) => {
      signal = s;
      return new Promise<string>((resolve) => (resolveText = resolve));
    },
  };
  const voice = new OnDemandVoice(configs, cb, deps, manual, continuous);
  return {
    voice,
    speech: (a: boolean) => speech(a),
    ready: () => {
      resolveConnect();
    },
    text: (s: string) => resolveText(s),
    get signal() {
      return signal;
    },
    get creates() {
      return creates;
    },
    get closed() {
      return closed;
    },
    get micStopped() {
      return micStopped;
    },
    get captures() {
      return captures;
    },
    get callbacks() {
      return callbacks;
    },
    statuses,
    questions,
    events,
  };
}
test("arming creates no paid connection; first utterance waits for both transcript and ready", async () => {
  const s = setup();
  await s.voice.enable();
  assert.equal(s.creates, 0);
  assert.equal(s.statuses.at(-1), "armed");
  s.speech(true);
  await tick();
  assert.equal(s.creates, 1);
  s.speech(false);
  s.text("这是完整的第一句话");
  await tick();
  assert.equal(s.questions.length, 0);
  s.ready();
  await tick();
  assert.deepEqual(s.questions, ["这是完整的第一句话"]);
  assert.ok(s.events.includes("input:true"));
  s.speech(true);
  s.speech(false);
  await tick();
  assert.equal(s.creates, 1);
  await s.voice.close();
  assert.equal(s.micStopped, 1);
});
test("new speech during cold recognition invalidates old result and retains capture", async () => {
  const s = setup();
  await s.voice.enable();
  s.speech(true);
  await tick();
  s.ready();
  await tick();
  s.speech(false);
  const old = s.signal!;
  s.speech(true);
  assert.equal(old.aborted, true);
  s.text("过期的半句话");
  await tick();
  assert.equal(s.questions.length, 0);
  s.speech(false);
  s.text("完整问题以及后来的补充");
  await tick();
  assert.deepEqual(s.questions, ["完整问题以及后来的补充"]);
  await s.voice.close();
});
test("resume grace is cancelled by followup; final grace closes cloud but keeps mic", async () => {
  const s = setup();
  await s.voice.enable();
  s.speech(true);
  await tick();
  s.ready();
  s.speech(false);
  s.text("问题");
  await tick();
  s.voice.playbackResumed();
  s.speech(true);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.closed, 0);
  s.speech(false);
  s.voice.playbackResumed();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.closed, 1);
  assert.equal(s.micStopped, 0);
  assert.equal(s.statuses.at(-1), "armed");
  s.speech(true);
  await tick();
  assert.equal(s.creates, 2);
  s.ready();
  s.speech(false);
  s.text("下一次问题");
  await tick();
  await s.voice.close();
});
test("idle closes cloud without resuming podcast or stopping local mic", async () => {
  const s = setup();
  await s.voice.enable();
  s.speech(true);
  await tick();
  s.ready();
  s.speech(false);
  s.text("问题");
  await tick();
  await new Promise((r) => setTimeout(r, 65));
  assert.equal(s.closed, 1);
  assert.equal(s.micStopped, 0);
  assert.ok(s.events.some((e) => e === "closed:true:session-1"));
  await s.voice.close();
});
test("disable while transcription pending prevents late speech or reconnect", async () => {
  const s = setup();
  await s.voice.enable();
  s.speech(true);
  await tick();
  s.ready();
  s.speech(false);
  await s.voice.close();
  s.text("太迟的结果");
  await tick();
  assert.equal(s.questions.length, 0);
  assert.equal(s.statuses.at(-1), "off");
});

test("slow backend work holds idle timer, then releases it", async () => {
  const s = setup();
  await s.voice.enable();
  s.speech(true);
  await tick();
  s.ready();
  s.speech(false);
  s.text("问题");
  await tick();
  s.voice.setWorking(true);
  await new Promise((r) => setTimeout(r, 65));
  assert.equal(s.closed, 0);
  s.voice.setWorking(false);
  await new Promise((r) => setTimeout(r, 65));
  assert.equal(s.closed, 1);
  await s.voice.close();
});

test("explicit resume during cold transcription cancels first question and later closes connection", async () => {
  const s = setup();
  await s.voice.enable();
  s.speech(true);
  await tick();
  s.ready();
  s.speech(false);
  s.voice.cancelCapture();
  s.text("过期问题");
  await tick();
  assert.equal(s.questions.length, 0);
  s.voice.playbackResumed();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.closed, 1);
  await s.voice.close();
});

test("continuous assistant audio cannot be mistaken for idle", async () => {
  const s = setup();
  await s.voice.enable();
  s.speech(true);
  await tick();
  s.ready();
  s.speech(false);
  s.text("问题");
  await tick();
  s.callbacks.onOutput(true);
  await new Promise((r) => setTimeout(r, 65));
  assert.equal(s.closed, 0);
  s.callbacks.onOutput(false);
  await new Promise((r) => setTimeout(r, 65));
  assert.equal(s.closed, 1);
  await s.voice.close();
});

test("manual mode ignores ambient speech and only submits on release, including warm follow-ups", async () => {
  const s = setup(true);
  await s.voice.enable();
  s.speech(true);
  s.speech(false);
  await tick();
  assert.equal(s.creates, 0);
  assert.equal(s.captures, 0);
  assert.equal(s.voice.beginManual(), true);
  await tick();
  s.ready();
  s.speech(false); // Silence while holding does not submit.
  assert.equal(s.signal, undefined);
  s.voice.endManual();
  s.text("第一个手动问题");
  await tick();
  assert.deepEqual(s.questions, ["第一个手动问题"]);
  assert.equal(s.events.includes("input:true"), false);
  assert.equal(s.voice.isWarm, true);
  assert.equal(s.voice.beginManual(), true);
  s.voice.endManual();
  s.text("手动追问");
  await tick();
  assert.deepEqual(s.questions, ["第一个手动问题", "手动追问"]);
  assert.equal(s.creates, 1);
  assert.equal(s.events.includes("input:true"), false);
  await s.voice.close();
});

test("manual resume cancels capture and rejects a late release or transcription", async () => {
  const s = setup(true);
  assert.equal(s.voice.beginManual(), false);
  await s.voice.enable();
  s.voice.beginManual();
  await tick();
  s.ready();
  s.voice.endManual();
  s.voice.cancelCapture();
  s.voice.endManual();
  s.text("已经取消的问题");
  await tick();
  assert.deepEqual(s.questions, []);
  assert.equal(s.events.includes("input:true"), false);
  await s.voice.close();
});

test("continuous automatic listening warms Live before speech and retains it during playback", async () => {
  const s = setup(false, true);
  await s.voice.enable();
  await tick();
  assert.equal(s.creates, 1);
  s.ready();
  await tick();
  assert.equal(s.voice.isWarm, true);
  s.voice.prepareOutput();
  s.voice.discardPendingOutput();
  assert.deepEqual(s.events.slice(-2), [
    "prepareOutput",
    "discardPendingOutput",
  ]);
  s.speech(true);
  s.speech(false);
  assert.equal(s.captures, 0);
  assert.equal(s.signal, undefined);
  s.voice.playbackResumed();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(s.closed, 0);
  assert.ok(s.events.includes("input:true"));
  await s.voice.close();
  assert.equal(s.closed, 1);
  assert.equal(s.micStopped, 1);
});

test("continuous listening: a detector that keeps firing after the connection cannot keep the microphone detached", async () => {
  const s = setup(false, true);
  await s.voice.enable();
  await tick();
  // The listener speaks before the session is connected: local capture.
  s.speech(true);
  assert.equal(s.captures, 1);
  s.ready();
  await tick();
  s.speech(false);
  const first = s.signal;
  // Loudspeaker bleed re-triggers the detector while that transcription runs.
  s.speech(true);
  s.speech(false);
  s.speech(true);
  assert.equal(s.captures, 1);
  assert.equal(first?.aborted, false);
  assert.equal(s.signal, first);
  s.text("wait");
  await tick();
  assert.deepEqual(s.questions, ["wait"]);
  assert.equal(s.voice.isCold, false);
  assert.equal(
    s.events.at(-1) === "input:true" || s.events.includes("input:true"),
    true,
  );
  // From here on speech belongs to the open session.
  s.speech(false);
  s.speech(true);
  assert.equal(s.captures, 1);
  assert.equal(s.closed, 0);
  await s.voice.close();
});

test("continuous listening: noise or a failed transcription before the connection keeps the session and attaches the microphone", async () => {
  const s = setup(false, true);
  await s.voice.enable();
  await tick();
  s.speech(true);
  s.ready();
  await tick();
  s.speech(false);
  s.text("  ");
  await tick();
  assert.deepEqual(s.questions, []);
  assert.equal(s.voice.isCold, false);
  assert.equal(s.closed, 0);
  assert.ok(s.events.includes("input:true"));
  assert.equal(
    s.events.some((x) => x.startsWith("error:")),
    false,
  );
  await s.voice.close();
});

test("on-demand listening still waits for the listener to finish before answering", async () => {
  const s = setup();
  await s.voice.enable();
  s.speech(true);
  await tick();
  s.ready();
  await tick();
  s.speech(false);
  const first = s.signal;
  s.speech(true);
  assert.equal(first?.aborted, true);
  assert.equal(s.captures, 2);
  await s.voice.close();
});
