import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveTranscript } from "../player-runtime/src/live-transcript";

test("a progress sentence waits for the new question instead of joining the interrupted reply", () => {
  const transcript = new LiveTranscript();
  transcript.resolve({ turnId: "a", startMs: 1000 }, "answer", "reply-a");
  transcript.append("上一条回答", { startMs: 2000, endMs: 3000 });
  transcript.observe({ turnId: "b", startMs: 4000 });
  transcript.append("我来查一下", { startMs: 5000, endMs: 5500 });
  assert.deepEqual(transcript.replies(), [
    { id: "reply-a", text: "上一条回答" },
  ]);
  transcript.resolve({ turnId: "b", startMs: 4000 }, "answer", "reply-b");
  assert.deepEqual(transcript.replies(), [
    { id: "reply-a", text: "上一条回答" },
    { id: "reply-b", text: "我来查一下" },
  ]);
  transcript.append("，阿Q这个名字…", { startMs: 6000, endMs: 6500 });
  transcript.append("的结尾", { startMs: 3000, endMs: 3500 });
  assert.deepEqual(transcript.replies(), [
    { id: "reply-a", text: "上一条回答的结尾" },
    { id: "reply-b", text: "我来查一下，阿Q这个名字…" },
  ]);
});

test("late sideband observation can revise captions that arrived first", () => {
  const transcript = new LiveTranscript();
  transcript.resolve({ turnId: "a", startMs: 0 }, "answer", "a");
  transcript.append("Old answer", { startMs: 1000, endMs: 2000 });
  transcript.append("Let me check.", { startMs: 4000, endMs: 4500 });
  transcript.observe({ turnId: "b", startMs: 3000 });
  assert.equal(transcript.replies()[0].text, "Old answer");
  transcript.resolve({ turnId: "b", startMs: 3000 }, "answer", "b");
  assert.equal(transcript.replies()[1].text, "Let me check.");
});

test("ignored bystander speech restores the original reply and wait keeps captions pending", () => {
  const transcript = new LiveTranscript();
  transcript.resolve({ turnId: "a" }, "answer", "a");
  transcript.append("A reply");
  transcript.observe({ turnId: "b" });
  transcript.append(" that continues");
  transcript.resolve({ turnId: "b" }, "wait", "wait");
  assert.equal(transcript.replies()[0].text, "A reply");
  transcript.resolve({ turnId: "b" }, "ignore", "ignore");
  assert.deepEqual(transcript.replies(), [
    { id: "a", text: "A reply that continues" },
  ]);
});

test("old observations cannot reopen resolved turns; control replies stay out of chat", () => {
  const transcript = new LiveTranscript();
  transcript.resolve({ turnId: "a", startMs: 0 }, "answer", "a");
  transcript.append("Old", { startMs: 100, endMs: 200 });
  transcript.observe({ turnId: "b", startMs: 300 });
  transcript.observe({ turnId: "b", startMs: 300 });
  transcript.append("Unsolicited confirmation", { startMs: 400, endMs: 500 });
  transcript.resolve({ turnId: "b", startMs: 300 }, "player_control", "b");
  transcript.observe({ turnId: "b", startMs: 300 });
  transcript.append("More unsolicited text", { startMs: 600, endMs: 700 });
  assert.deepEqual(transcript.replies(), [{ id: "a", text: "Old" }]);
  transcript.clear();
  assert.deepEqual(transcript.replies(), []);
  transcript.append("No answer owns this");
  assert.deepEqual(transcript.replies(), []);
});

test("a superseded pending input returns its continuation to the preceding accepted reply", () => {
  const transcript = new LiveTranscript();
  transcript.resolve({ turnId: "a" }, "answer", "a");
  transcript.observe({ turnId: "b" });
  transcript.append("Still the first reply");
  transcript.observe({ turnId: "c" });
  transcript.append("New reply");
  transcript.resolve({ turnId: "c" }, "answer", "c");
  assert.deepEqual(transcript.replies(), [
    { id: "a", text: "Still the first reply" },
    { id: "c", text: "New reply" },
  ]);
});

test("retention keeps whole captions and never loses the active answer to background input", () => {
  const transcript = new LiveTranscript();
  transcript.resolve({ turnId: "a", startMs: 0 }, "answer", "a");
  transcript.append("Beginning", { startMs: 1, endMs: 2 });
  for (let i = 1; i <= 60; i++)
    transcript.resolve(
      { turnId: `ignore-${i}`, startMs: i * 10 },
      "ignore",
      `ignore-${i}`,
    );
  transcript.append(" ending", { startMs: 610, endMs: 620 });
  assert.deepEqual(transcript.replies(), [
    { id: "a", text: "Beginning ending" },
  ]);
  for (let i = 1; i <= 45; i++) {
    transcript.resolve(
      { turnId: `b-${i}`, startMs: 1000 * i },
      "answer",
      `b-${i}`,
    );
    transcript.append(`Whole reply ${i}`, {
      startMs: 1000 * i + 100,
      endMs: 1000 * i + 200,
    });
  }
  assert.equal(transcript.replies().length, 40);
  assert.deepEqual(transcript.replies()[0], {
    id: "b-6",
    text: "Whole reply 6",
  });
  assert.deepEqual(transcript.replies().at(-1), {
    id: "b-45",
    text: "Whole reply 45",
  });
});
