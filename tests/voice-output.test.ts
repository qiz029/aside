import { test } from "node:test";
import assert from "node:assert/strict";
import { VoiceOutputQueue } from "../frontend/src/voice-output-worklet.js";

const samples = (...values: number[]) => Float32Array.from(values);

test("given audio arrives before approval, it stays silent then plays the complete prefix in order", () => {
  const q = new VoiceOutputQueue(100, 1);
  q.command("hold");
  assert.deepEqual([...q.process(samples(1, 2, 3))], [0, 0, 0]);
  q.command("hold"); // More partial recognition must not erase the prefix.
  assert.deepEqual([...q.process(samples(4, 5))], [0, 0]);
  q.command("play");
  assert.deepEqual([...q.process(samples(6, 7, 8))], [1, 2, 3]);
  assert.deepEqual([...q.process(samples(9, 10, 11))], [4, 5, 6]);
  assert.deepEqual(
    [...q.process(samples(12, 13, 14, 15, 16))],
    [7, 8, 9, 10, 11],
  );
});

test("given a long wait before speech, only a short silent preroll is retained", () => {
  const q = new VoiceOutputQueue(100, 1);
  q.command("hold");
  for (let i = 0; i < 100; i++) q.process(new Float32Array(10));
  assert.equal(q.snapshot().bufferedFrames, 20);
  q.process(samples(0.001, 0.002)); // Keep quiet consonants, not just loud syllables.
  q.command("play");
  assert.deepEqual(
    [...q.process(new Float32Array(22))],
    [...new Array(20).fill(0), ...samples(0.001, 0.002)],
  );
});

test("given ignore or cancellation, buffered audio cannot leak into the next answer", () => {
  const q = new VoiceOutputQueue(100, 1);
  q.command("hold");
  q.process(samples(1, 2));
  q.command("discard");
  assert.deepEqual([...q.process(samples(3, 4))], [0, 0]);
  q.command("hold");
  q.process(samples(5, 6));
  q.command("play");
  assert.deepEqual([...q.process(samples(7, 8))], [5, 6]);
  q.command("discard");
  assert.deepEqual([...q.process(samples(9, 10))], [0, 0]);
});

test("given a bystander while an answer is playing, prepare/discard pending does not cut that answer", () => {
  const q = new VoiceOutputQueue(100, 1);
  q.command("play");
  q.command("hold");
  q.command("discard-pending");
  assert.deepEqual([...q.process(samples(1, 2))], [1, 2]);
});

test("given overflow, reject the whole answer instead of silently dropping its beginning", () => {
  const q = new VoiceOutputQueue(10, 1);
  q.command("hold");
  q.process(new Float32Array(10).fill(1));
  q.process(samples(2));
  assert.equal(q.snapshot().overflows, 1);
  assert.equal(q.snapshot().bufferedFrames, 0);
  q.command("hold");
  q.command("play");
  assert.deepEqual([...q.process(samples(3))], [0]);
  q.command("discard");
  q.command("hold");
  q.process(samples(4));
  q.command("play");
  assert.deepEqual([...q.process(samples(5))], [4]);
});
