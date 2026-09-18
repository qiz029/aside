import { test } from "node:test";
import assert from "node:assert/strict";
import { SpokenCompletion } from "@aside/player-runtime/spoken-completion";

test("thinking gaps, backend completion and captions alone cannot authorize resume", () => {
  const c = new SpokenCompletion();
  c.outputStarted();
  c.transcript("Let me check that.");
  c.outputDrained();
  assert.equal(c.complete, false);
  c.answer("A biography tells the story of a person's life.");
  assert.equal(c.complete, false);
  c.outputStarted();
  c.transcript(
    "Let me check that. A biography tells the story of a person's life.",
  );
  assert.equal(c.complete, false, "remaining native audio must finish");
  c.outputDrained();
  assert.equal(c.complete, true);
});

test("late final metadata can confirm audio already heard; new output revokes drained evidence", () => {
  const c = new SpokenCompletion();
  c.outputStarted();
  c.transcript("这是一个关于好奇心的故事。");
  c.outputDrained();
  c.answer("这是一个关于好奇心的故事");
  assert.equal(c.complete, true);
  c.outputStarted();
  assert.equal(c.complete, false);
});

test("truncated, paraphrased, changed-number and short ambiguous replies require manual continuation", () => {
  for (const [expected, heard] of [
    ["It cost 15 dollars in 2025.", "It cost 50 dollars in 2025."],
    ["A biography is someone's life story.", "A biography is someone's life"],
    ["Yes", "Yes, let me check."],
    ["", "Done."],
    ["They moved to Paris.", "They went to Paris."],
    ["It is 1.5 dollars.", "It is 15 dollars."],
    ["We can record a nice story.", "We can record an ice story."],
  ]) {
    const c = new SpokenCompletion();
    c.answer(expected);
    c.outputStarted();
    c.transcript(heard);
    c.outputDrained();
    assert.equal(c.complete, false, `${expected} / ${heard}`);
  }
});
