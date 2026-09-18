import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import type {
  VoiceCallbacks,
  VoiceFactory,
  VoicePort,
} from "@aside/player-runtime/ports";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

/** Exercise the shipped native controller; replace only unavailable OS/RTC boundaries. */
async function fixture(
  t: TestContext,
  stalledConnection = false,
  automatic = false,
  platform: "ios" | "android" = "ios",
) {
  class Recorder {
    uri: string | null = null;
    isRecording = false;
    currentTime = 0;
    async prepareToRecordAsync() {
      this.uri = "file:///question.m4a";
    }
    record() {
      this.isRecording = true;
      this.currentTime = 2;
    }
    async stop() {
      this.isRecording = false;
    }
  }
  class File {
    exists = true;
    size = 16000;
    delete() {
      this.exists = false;
    }
  }
  const peers: Peer[] = [];
  class Peer {
    constructor() {
      peers.push(this);
    }
    sent: { type: string; content?: string }[] = [];
    channel = {
      readyState: "open",
      onmessage: (_event: { data: string }) => {},
      send: (data: string) => {
        this.sent.push(JSON.parse(data));
        if (JSON.parse(data).type === "session.close")
          this.channel.onmessage({ data: '{"type":"session.closed"}' });
      },
      close() {},
    };
    outgoing: unknown[] = [];
    connectionState = "connected";
    onconnectionstatechange = () => {};
    closed = false;
    addTransceiver() {}
    addTrack(track: unknown) {
      this.outgoing.push(track);
    }
    createDataChannel() {
      return this.channel;
    }
    async createOffer() {
      return { sdp: "fixture-offer" };
    }
    async setLocalDescription() {}
    async setRemoteDescription() {
      this.channel.onmessage({ data: '{"type":"session.started"}' });
    }
    async getStats() {
      return new Map();
    }
    close() {
      this.closed = true;
      this.channel.readyState = "closed";
    }
  }
  const key = `asideVoiceTest_${crypto.randomUUID()}`;
  const globals = globalThis as unknown as Record<string, unknown>;
  const nativeStatus = {
    generation: 0,
    mode: 0,
    active: false,
    drained: false,
    overflows: 0,
    receivedFrames: 0,
    playedThroughFrame: 0,
    bufferedMs: 0,
    inputLevel: 0,
  };
  const streams: {
    released: boolean;
    track: { stopped: boolean; released: boolean };
  }[] = [];
  globals[key] = { Recorder, File, Peer, nativeStatus, streams };
  const ref = `globalThis[${JSON.stringify(key)}]`;
  const modules: Record<string, string> = {
    "expo-audio": `export const AudioModule={AudioRecorder:${ref}.Recorder}; export const RecordingPresets={HIGH_QUALITY:{ios:{},android:{}}};`,
    "expo-file-system": `export const File=${ref}.File;`,
    "react-native": `const status=${ref}.nativeStatus; export const Platform={OS:${JSON.stringify(platform)}}; export class NativeEventEmitter {addListener(){return {remove(){}}}}; export const NativeModules={AsideAudioSession:{resetOutput:async(g)=>{status.generation=g;},outputCommand:async(g,e,m)=>{status.mode=m;},audioStatus:async()=>({...status}),createSilentTrack: async () => ({id:"silence",kind:"audio",enabled:true,remote:false,readyState:"live"})}};`,
    "react-native-webrtc": `export const RTCPeerConnection=${ref}.Peer; const streams=${ref}.streams; export const mediaDevices={getUserMedia:async()=>{const track=new MediaStreamTrack({id:"microphone",kind:"audio"});const stream={track,released:false,getAudioTracks:()=>[track],release(){this.released=true}};streams.push(stream);return stream;}}; export class MediaStreamTrack { stopped=false;released=false;constructor(info) {Object.assign(this,info)} stop(){this.stopped=true} release(){this.released=true} }`,
  };
  const bundle = await build({
    entryPoints: ["mobile/src/voice.ts"],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    plugins: [
      {
        name: "native-test-boundaries",
        setup(builder) {
          builder.onResolve(
            {
              filter:
                /^(expo-audio|expo-file-system|react-native|react-native-webrtc)$/,
            },
            ({ path }) => ({ path, namespace: "native-test" }),
          );
          builder.onLoad(
            { filter: /.*/, namespace: "native-test" },
            ({ path }) => ({ contents: modules[path], loader: "js" }),
          );
        },
      },
    ],
  });
  const { NativeVoice } = (await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  )) as { NativeVoice: new (...args: unknown[]) => VoicePort };
  delete globals[key];
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const statuses: string[] = [],
    recognized: string[] = [],
    questions: string[] = [],
    errors: string[] = [],
    outputs: boolean[] = [],
    closes: Parameters<VoiceCallbacks["onClose"]>[] = [],
    transcripts: string[] = [];
  const speech: boolean[] = [];
  let drains = 0;
  const cb: VoiceCallbacks = {
    onReady() {},
    onOutput(value) {
      outputs.push(value);
    },
    onTranscript(_role, text) {
      transcripts.push(text);
    },
    onDelegation() {},
    onSpeech(value) {
      speech.push(value);
    },
    onOutputDrained() {
      drains++;
    },
    onClose(...event) {
      closes.push(event);
    },
    onStatus: (status) => {
      statuses.push(status);
    },
    onFirstQuestion: (text) => {
      questions.push(text);
    },
    onQuestionRecognized: (text) => {
      recognized.push(text);
    },
    onError: (error) => {
      errors.push(error);
    },
  };
  const transcription = deferred<string>();
  const connection =
    deferred<Awaited<ReturnType<Parameters<VoiceFactory>[3]["create"]>>>();
  const voice = new NativeVoice(
    cb,
    {
      transcribe: () => transcription.promise,
      create: () =>
        stalledConnection
          ? connection.promise
          : Promise.resolve({
              session: { id: "fixture-session" },
              transport: { sdp: "fixture-answer" },
            }),
    },
    {
      record: async () => {},
      listen: async () => {},
      answer: async () => {},
      finishQuestion: async () => {},
    },
    { preRollMs: 750, graceMs: 5000, idleCloseMs: 2000 },
    !automatic,
    { threshold: 0.025, minSpeechMs: 120, silenceMs: 650 },
  );
  t.after(async () => {
    await voice.close();
  });
  await voice.enable();
  if (!automatic) {
    assert.equal(voice.beginManual(), true);
    await flush();
    voice.endManual();
  }
  await flush();
  return {
    voice,
    statuses,
    recognized,
    questions,
    errors,
    transcription,
    connection,
    peers,
    streams,
    outputs,
    closes,
    transcripts,
    nativeStatus,
    speech,
    get drains() {
      return drains;
    },
  };
}

test("native manual waiting releases its idle Live session without resuming the podcast", async (t) => {
  const s = await fixture(t);
  s.transcription.resolve("Question");
  await flush();
  s.voice.activity();
  t.mock.timers.tick(1999);
  await flush();
  assert.equal(s.voice.isEnabled, true);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(s.voice.isEnabled, false);
  assert.equal(s.statuses.at(-1), "off");
  assert.deepEqual(s.closes, [[true, 0, "fixture-session", true]]);
  assert.deepEqual(
    s.outputs,
    [],
    "closing idle Live must not request playback",
  );
});

test("native idle expiry waits for transcription, backend work and renewed activity", async (t) => {
  const s = await fixture(t);
  s.voice.activity();
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(s.voice.isEnabled, true, "ASR is still pending");
  s.transcription.resolve("Question");
  await flush();
  s.voice.setWorking(true);
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(s.voice.isEnabled, true, "backend work is still pending");
  s.voice.setWorking(false);
  t.mock.timers.tick(1500);
  s.peers[0].channel.onmessage({
    data: JSON.stringify({
      type: "session.output_transcript.delta",
      delta: "Answer",
    }),
  });
  t.mock.timers.tick(1500);
  await flush();
  assert.equal(
    s.voice.isEnabled,
    true,
    "recent answer activity resets idle time",
  );
  t.mock.timers.tick(500);
  await flush();
  assert.equal(s.voice.isEnabled, false);
});

test("server session expiry releases native resources and ignores late answer captions", async (t) => {
  const s = await fixture(t);
  s.transcription.resolve("Question");
  await flush();
  s.peers[0].channel.onmessage({ data: '{"type":"session.closed"}' });
  await flush();
  assert.equal(
    s.voice.isEnabled,
    false,
    "next hold must create a fresh voice instance",
  );
  assert.equal(s.voice.isWarm, false);
  assert.equal(s.peers[0].closed, true);
  assert.equal(s.statuses.at(-1), "off");
  assert.deepEqual(s.closes, [[true, 0, "fixture-session", false]]);
  s.peers[0].channel.onmessage({
    data: '{"type":"session.output_transcript.delta","delta":"stale"}',
  });
  assert.deepEqual(s.transcripts, []);
  assert.equal(s.voice.beginManual(), false);
});

test("active native answer audio and a new recording suppress idle closure", async (t) => {
  const s = await fixture(t);
  s.transcription.resolve("Question");
  await flush();
  s.nativeStatus.active = true;
  for (let i = 0; i < 30; i++) {
    t.mock.timers.tick(100);
    await flush();
  }
  assert.deepEqual(s.outputs, [true]);
  assert.equal(s.voice.isEnabled, true, "ongoing audio must not expire");
  s.voice.interrupt();
  assert.equal(s.voice.beginManual(), true);
  await flush();
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(s.voice.isEnabled, true, "a held recording must not expire");
});

test("a failed warm native peer is released so the next hold can reconnect", async (t) => {
  const s = await fixture(t);
  s.transcription.resolve("Question");
  await flush();
  s.peers[0].connectionState = "failed";
  s.peers[0].onconnectionstatechange();
  await flush();
  assert.match(s.errors[0], /Voice disconnected/);
  assert.equal(s.voice.isEnabled, false);
  assert.equal(s.peers[0].closed, true);
});

test("native voice keeps transcription progress visible when Live connects first", async (t) => {
  const s = await fixture(t);
  assert.equal(s.statuses.at(-1), "transcribing");
  assert.deepEqual(s.questions, []);
  s.transcription.resolve("  What did the speaker mean?  ");
  await flush();
  assert.deepEqual(s.questions, ["What did the speaker mean?"]);
  assert.deepEqual(s.recognized, s.questions);
  assert.equal(s.statuses.at(-1), "on");
});

test("native voice reports an empty transcription instead of submitting an invisible question", async (t) => {
  const s = await fixture(t);
  s.transcription.resolve("  \n ");
  await flush();
  assert.deepEqual(s.questions, []);
  assert.deepEqual(s.recognized, []);
  assert.match(s.errors[0] ?? "", /没有识别|speech/i);
});

test("native voice connection timeout includes the pending HTTP negotiation", async (t) => {
  const s = await fixture(t, true);
  s.transcription.resolve("What did the speaker mean?");
  await flush();
  assert.equal(s.statuses.at(-1), "connecting");
  assert.deepEqual(s.recognized, ["What did the speaker mean?"]);
  assert.deepEqual(
    s.questions,
    [],
    "the paid question must still wait for Live",
  );
  t.mock.timers.tick(30001);
  await flush();
  assert.match(s.errors[0] ?? "", /timed out/i);
  assert.deepEqual(s.questions, []);
});

test("a cancelled native capture cannot publish a late transcription", async (t) => {
  const s = await fixture(t);
  s.voice.cancelCapture();
  await flush();
  const statuses = [...s.statuses];
  s.transcription.resolve("A cancelled question");
  await flush();
  assert.deepEqual(s.statuses, statuses);
  assert.deepEqual(s.questions, []);
  assert.deepEqual(s.recognized, []);
  assert.deepEqual(s.errors, []);
});

test("a session arriving after timeout is closed without submitting the old question", async (t) => {
  const s = await fixture(t, true);
  s.transcription.resolve("A question that timed out");
  await flush();
  t.mock.timers.tick(30001);
  await flush();
  const statuses = [...s.statuses];
  s.connection.resolve({
    session: { id: "late-session" },
    transport: { sdp: "late-answer" },
  } as Awaited<ReturnType<Parameters<VoiceFactory>[3]["create"]>>);
  await flush();
  assert.deepEqual(s.questions, []);
  assert.deepEqual(s.statuses, statuses);
  assert.equal(s.errors.length, 1);
});

// A held follow-up can begin while the cold Live HTTP request is still in flight.
test("rapid native re-recording reuses the in-flight Live connection", async (t) => {
  const s = await fixture(t, true);
  assert.equal(s.peers.length, 1);
  assert.equal(s.voice.beginManual?.(), true);
  await flush();
  s.voice.endManual?.();
  await flush();
  assert.equal(s.peers.length, 1);
  s.connection.resolve({
    session: { id: "shared-session" },
    transport: { sdp: "answer" },
  });
  s.transcription.resolve("Newest question");
  await flush();
  assert.deepEqual(s.questions, ["Newest question"]);
});

test("native Live supplies a silent input track to advance the model audio timeline", async (t) => {
  const s = await fixture(t);
  assert.equal(s.peers[0].outgoing.length, 1);
  assert.equal((s.peers[0].outgoing[0] as { id: string }).id, "silence");
});

test("native Live receives the actual recognized question and language before answering", async (t) => {
  const s = await fixture(t);
  s.transcription.resolve("What is this interview about?");
  await flush();
  const thinking = s.peers[0].sent.find(
    (e) => e.type === "session.thinking.append",
  );
  assert.match(
    thinking?.content ?? "",
    /Latest actual user utterance.*What is this interview about/,
  );
  assert.ok(
    s.peers[0].sent.some(
      (e) =>
        e.type === "session.instructions.append" &&
        e.content?.includes("language"),
    ),
  );
});

test("native playback callbacks follow rendered PCM rather than incoming RTP energy", async (t) => {
  const s = await fixture(t);
  s.transcription.resolve("Question");
  await flush();
  t.mock.timers.tick(100);
  await flush();
  assert.deepEqual(s.outputs, []);
  s.nativeStatus.active = true;
  t.mock.timers.tick(100);
  await flush();
  assert.deepEqual(s.outputs, [true]);
  s.nativeStatus.active = false;
  t.mock.timers.tick(1400);
  await flush();
  assert.deepEqual(s.outputs, [true, false]);
});

test("continuous native listening survives idle time and podcast resumption", async (t) => {
  const s = await fixture(t, false, true);
  assert.equal(s.voice.isWarm, true);
  assert.equal(s.voice.isCold, false);
  assert.equal(s.voice.beginManual(), false);
  s.voice.playbackResumed();
  t.mock.timers.tick(120000);
  await flush();
  assert.equal(s.voice.isEnabled, true);
  assert.equal(s.peers[0].closed, false);
  assert.deepEqual(
    s.questions,
    [],
    "continuous input uses server delegation, not local ASR",
  );
});

test("continuous native output holds captions until actual admitted audio and reports drained afterwards", async (t) => {
  const s = await fixture(t, false, true);
  s.voice.prepareOutput?.();
  await flush();
  s.nativeStatus.receivedFrames = 500;
  t.mock.timers.tick(50);
  await flush();
  s.peers[0].channel.onmessage({
    data: '{"type":"session.output_transcript.delta","delta":"The first words."}',
  });
  assert.deepEqual(s.transcripts, []);
  s.voice.mute(false);
  await flush();
  s.nativeStatus.active = true;
  s.nativeStatus.playedThroughFrame = 499;
  t.mock.timers.tick(50);
  await flush();
  assert.deepEqual(s.outputs, [true]);
  assert.deepEqual(s.transcripts, [], "unplayed caption stays queued");
  s.nativeStatus.playedThroughFrame = 500;
  t.mock.timers.tick(50);
  await flush();
  assert.deepEqual(s.transcripts, ["The first words."]);
  s.nativeStatus.active = false;
  s.nativeStatus.drained = true;
  t.mock.timers.tick(50);
  await flush();
  assert.deepEqual(s.outputs, [true, false]);
  assert.equal(s.drains, 1);
});

test("continuous input amplitude detects sustained speech and a cancelled reply cannot leak captions", async (t) => {
  const s = await fixture(t, false, true);
  s.nativeStatus.inputLevel = 0.1;
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(50);
    await flush();
  }
  assert.deepEqual(s.speech, [true]);
  assert.equal(s.voice.inputLevel?.(), 0.1);
  s.nativeStatus.inputLevel = 0;
  for (let i = 0; i < 14; i++) {
    t.mock.timers.tick(50);
    await flush();
  }
  assert.deepEqual(s.speech, [true, false]);
  s.voice.prepareOutput?.();
  await flush();
  s.peers[0].channel.onmessage({
    data: '{"type":"session.output_transcript.delta","delta":"Cancelled words"}',
  });
  s.voice.interrupt();
  s.voice.mute(false);
  await flush();
  s.nativeStatus.active = true;
  s.nativeStatus.playedThroughFrame = 1000;
  t.mock.timers.tick(50);
  await flush();
  assert.deepEqual(s.transcripts, []);
});

for (const platform of ["ios", "android"] as const)
  test(`${platform} closes local media before waiting for a remote close acknowledgement`, async (t) => {
    const s = await fixture(t, false, true, platform);
    const peer = s.peers[0];
    peer.channel.send = () => {}; // A supplier that never confirms closure.
    const closing = s.voice.close();
    const track = peer.outgoing[0] as { stopped: boolean; released: boolean };
    assert.equal(track.stopped, true);
    assert.equal(track.released, true);
    assert.equal(
      peer.closed,
      false,
      "keep only the data channel for the bounded final usage acknowledgement",
    );
    if (platform === "android")
      assert.equal(
        s.streams[0].released,
        true,
        "release the native stream registry entry too",
      );
    t.mock.timers.tick(3000);
    await closing;
    assert.equal(peer.closed, true);
  });
