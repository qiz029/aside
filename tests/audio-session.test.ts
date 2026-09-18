import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AudioSessionCoordinator,
  NativePlaybackEvents,
} from "../mobile/src/audio-session.js";

function fixture() {
  const events: string[] = [];
  const coordinator = new AudioSessionCoordinator({
    configure: async (recording) => {
      events.push(recording ? "record" : "playback");
    },
    activate: async (active) => {
      events.push(active ? "active" : "inactive");
    },
  });
  return { coordinator, events };
}
test("enabling conversation during playback does not turn category-change pauses into user stops", async () => {
  const transport = new NativePlaybackEvents();
  const actions: (string | null)[] = [];
  let playing = false;
  const c = new AudioSessionCoordinator({
    configure: async () => {
      playing = false;
      actions.push(
        transport.observe({ playing, isLoaded: true, isBuffering: false }),
      );
    },
    activate: async () => {},
  });
  c.bindPodcast({
    pause: () => {
      transport.requestedPause();
      playing = false;
    },
    resume: () => {
      transport.requestedPlay();
      playing = true;
    },
  });
  await c.playPodcast();
  transport.observe({ playing, isLoaded: true, isBuffering: false });
  const owner = Symbol();
  await c.listen(owner);
  assert.equal(playing, true);
  transport.observe({ playing, isLoaded: true, isBuffering: false });
  await c.finishQuestion(owner);
  assert.equal(playing, true);
  assert.ok(actions.every((action) => action === null));
  transport.observe({ playing, isLoaded: true, isBuffering: false });
  assert.equal(
    transport.observe({ playing: false, isLoaded: true, isBuffering: false }),
    "pause",
    "a later real system pause is still honored",
  );
});

test("a user pause during category change prevents the automatic playback restore", async () => {
  let release!: () => void;
  let block = false,
    resumed = 0;
  const c = new AudioSessionCoordinator({
    configure: async () => {
      if (block)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
    },
    activate: async () => {},
  });
  c.bindPodcast({
    pause: () => {},
    resume: () => {
      resumed++;
    },
  });
  await c.playPodcast();
  resumed = 0;
  block = true;
  const enabling = c.listen(Symbol());
  await new Promise((resolve) => setImmediate(resolve));
  await c.pausePodcast();
  release();
  await enabling;
  assert.equal(resumed, 0);
});
test("pausing a podcast cannot release a newly acquired microphone", async () => {
  const { coordinator: c, events } = fixture();
  await c.playPodcast();
  events.length = 0;
  const pause = c.pausePodcast();
  await c.record(Symbol("question"));
  await pause;
  assert.deepEqual(events, ["record", "active"]);
});
test("late cleanup of an old answer cannot stop a follow-up recording", async () => {
  const { coordinator: c, events } = fixture();
  const old = Symbol(),
    next = Symbol();
  await c.record(old);
  await c.record(next);
  events.length = 0;
  await c.finishQuestion(old);
  await c.answer(old);
  assert.deepEqual(events, []);
  await c.answer(next);
  assert.deepEqual(events, ["playback", "active"]);
});
test("closing a voice connection after resume preserves podcast audio", async () => {
  const { coordinator: c, events } = fixture();
  const voice = Symbol();
  await c.record(voice);
  await c.playPodcast();
  events.length = 0;
  await c.finishQuestion(voice);
  assert.deepEqual(events, []);
  await c.pausePodcast();
  assert.deepEqual(events, ["playback", "inactive"]);
});
test("a failed session transition does not poison subsequent attempts", async () => {
  let attempts = 0;
  const active: boolean[] = [];
  const c = new AudioSessionCoordinator({
    configure: async () => {
      if (++attempts === 1) throw Error("interrupted");
    },
    activate: async (value) => {
      active.push(value);
    },
  });
  await assert.rejects(c.record(Symbol()), /interrupted/);
  await c.playPodcast();
  assert.deepEqual(active, [true]);
});

test("follow-up capture stops the live audio unit before changing the native session", async () => {
  let liveUnit = false;
  const events: string[] = [];
  const c = new AudioSessionCoordinator({
    async enableAnswer(enabled) {
      liveUnit = enabled;
      events.push(enabled ? "live-start" : "live-stop");
    },
    async configure(recording) {
      if (liveUnit) throw Error("Session activation failed");
      events.push(recording ? "record" : "playback");
    },
    async activate(active) {
      events.push(active ? "active" : "inactive");
    },
  });
  const question = Symbol();
  await c.record(question);
  await c.answer(question);
  assert.equal(liveUnit, true);
  events.length = 0;
  await c.record(question);
  assert.deepEqual(events, ["live-stop", "record", "active"]);
  assert.equal(liveUnit, false);
  await c.answer(question);
  events.length = 0;
  await c.playPodcast();
  assert.deepEqual(events, ["live-stop", "playback", "active"]);
  assert.equal(liveUnit, false);
});

test("cancel during native activation cannot restart the old answer audio unit", async () => {
  let unblock!: () => void;
  let delayActivation = false;
  const wait = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const grants: boolean[] = [];
  const c = new AudioSessionCoordinator({
    configure: async () => {},
    activate: async () => {
      if (delayActivation) await wait;
    },
    enableAnswer: async (enabled) => {
      grants.push(enabled);
    },
  });
  const owner = Symbol();
  await c.record(owner);
  delayActivation = true;
  const answer = c.answer(owner);
  await new Promise((resolve) => setImmediate(resolve));
  const finish = c.finishQuestion(owner);
  unblock();
  await Promise.all([answer, finish]);
  assert.equal(grants.includes(true), false);
});
test("a release queued during native preparation prevents late activation", async () => {
  let unblock!: () => void;
  const wait = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const active: boolean[] = [];
  let first = true;
  const c = new AudioSessionCoordinator({
    configure: async () => {
      if (first) {
        first = false;
        await wait;
      }
    },
    activate: async (value) => {
      active.push(value);
    },
  });
  const voice = Symbol();
  const recording = c.record(voice);
  await Promise.resolve();
  await Promise.resolve();
  const release = c.finishQuestion(voice);
  unblock();
  await Promise.all([recording, release]);
  assert.deepEqual(active, [false]);
});

test("a delayed native pause after seek cannot cancel a newly requested play", () => {
  const events = new NativePlaybackEvents();
  const status = (playing: boolean) => ({
    playing,
    isLoaded: true,
    isBuffering: false,
  });
  events.requestedPlay();
  assert.equal(events.observe(status(true)), null);
  events.requestedPause();
  events.requestedPlay();
  assert.equal(events.observe(status(false)), null);
  assert.equal(events.observe(status(true)), null);
  assert.equal(events.observe(status(false)), "pause");
  assert.equal(events.observe(status(true)), "play");
});
test("a delayed playing event after explicit pause cannot restart playback", () => {
  const events = new NativePlaybackEvents();
  events.requestedPause();
  assert.equal(
    events.observe({ playing: true, isLoaded: true, isBuffering: false }),
    null,
  );
  assert.equal(
    events.observe({ playing: false, isLoaded: true, isBuffering: false }),
    null,
  );
  assert.equal(
    events.observe({ playing: true, isLoaded: true, isBuffering: false }),
    "play",
  );
});

test("continuous input survives podcast duck/pause/resume without reactivating the audio session", async () => {
  const events: string[] = [];
  const c = new AudioSessionCoordinator({
    configure: async (recording, continuous) => {
      events.push(`configure:${recording}:${continuous}`);
    },
    activate: async (active) => {
      events.push(`active:${active}`);
    },
    enableInput: async (input) => {
      events.push(`input:${input}`);
    },
    enableAnswer: async (answer) => {
      events.push(`answer:${answer}`);
    },
  });
  await c.playPodcast();
  const voice = Symbol();
  await c.listen(voice);
  assert.deepEqual(events.slice(-6), [
    "answer:false",
    "input:false",
    "configure:true:true",
    "active:true",
    "input:true",
    "answer:true",
  ]);
  events.length = 0;
  await c.pausePodcast();
  await c.answer(voice);
  await c.playPodcast();
  assert.deepEqual(
    events,
    [],
    "no session category change in a continuous conversation",
  );
  await c.finishQuestion(voice);
  assert.deepEqual(events, [
    "answer:false",
    "input:false",
    "configure:false:false",
    "active:true",
  ]);
});

test("background/close during continuous preparation cannot activate capture late", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inputs: boolean[] = [];
  const c = new AudioSessionCoordinator({
    configure: async (_recording, continuous) => {
      if (continuous) await gate;
    },
    activate: async () => {},
    enableInput: async (enabled) => {
      inputs.push(enabled);
    },
  });
  const owner = Symbol();
  const pending = c.listen(owner);
  await new Promise((resolve) => setImmediate(resolve));
  const close = c.finishQuestion(owner);
  release();
  await pending;
  await close;
  assert.equal(inputs.includes(true), false);
});

test("late continuous cleanup cannot close a replacement microphone", async () => {
  const { coordinator: c, events } = fixture();
  const old = Symbol(),
    next = Symbol();
  await c.listen(old);
  await c.listen(next);
  events.length = 0;
  await c.finishQuestion(old);
  assert.deepEqual(events, []);
});
