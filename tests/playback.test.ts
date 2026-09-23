import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialPlayback,
  transition,
  resumeAnchor,
  resumePoint,
  utteranceUnits,
  explicitResume,
  selectVoice,
} from "@aside/engine/core";
const anchor = {
  id: "a",
  startMs: 1000,
  endMs: 8000,
  text: "今天天气真好，我们准备出去走走。",
  confidence: 1,
};
test("sentence rewind remains fixed through follow-ups", () => {
  let s = transition(initialPlayback(), { type: "play" });
  s = transition(s, { type: "interrupt", atMs: 4500, anchor });
  assert.equal(s.interruption?.resumeMs, 1000);
  s = transition(s, { type: "user_end" });
  s = transition(s, { type: "assistant_start", revision: s.revision });
  s = transition(s, {
    type: "interrupt",
    atMs: 4600,
    anchor: { ...anchor, startMs: 4000 },
  });
  assert.equal(s.interruption?.resumeMs, 1000);
  assert.equal(s.interruption?.atMs, 4500);
});
test("silence never resumes and stale audio cannot end a newer turn", () => {
  let s = transition(initialPlayback(), {
    type: "interrupt",
    atMs: 4500,
    anchor,
  });
  const old = s.revision;
  s = transition(s, { type: "interrupt", atMs: 4500, anchor });
  assert.deepEqual(transition(s, { type: "assistant_end", revision: old }), s);
  s = transition(s, { type: "user_end" });
  s = transition(s, { type: "assistant_end", revision: s.revision });
  assert.equal(s.mode, "awaiting_followup");
});
test("resume waits for output and new speech invalidates pending resume", () => {
  let s = transition(initialPlayback(), {
    type: "interrupt",
    atMs: 4500,
    anchor,
  });
  s = transition(s, { type: "user_end" });
  s = transition(s, { type: "assistant_start", revision: s.revision });
  s = transition(s, { type: "resume" });
  assert.equal(s.mode, "answering");
  s = transition(s, { type: "assistant_end", revision: s.revision });
  assert.equal(s.mode, "resuming");
  const rev = s.revision;
  s = transition(s, { type: "interrupt", atMs: 4500, anchor });
  s = transition(s, { type: "resumed", revision: rev });
  assert.equal(s.mode, "listening");
});
test("resume reaches exact semantic anchor; seek cancels old anchor", () => {
  let s = transition(initialPlayback(), {
    type: "interrupt",
    atMs: 4500,
    anchor,
  });
  s = transition(s, { type: "user_end" });
  s = transition(s, { type: "resume" });
  s = transition(s, { type: "resumed", revision: s.revision });
  assert.equal(s.positionMs, 1000);
  assert.equal(s.mode, "playing");
  s = transition(s, { type: "seek", atMs: 9000 });
  assert.equal(s.interruption, undefined);
  assert.equal(s.positionMs, 9000);
});
test("disconnect preserves interruption but revokes output and resume", () => {
  let s = transition(initialPlayback(), {
    type: "interrupt",
    atMs: 4500,
    anchor,
  });
  s = transition(s, { type: "resume" });
  const rev = s.revision;
  s = transition(s, { type: "disconnect" });
  assert.equal(s.interruption?.resumeMs, 1000);
  assert.equal(s.resumeRequested, false);
  assert.equal(
    transition(s, { type: "resumed", revision: rev }).mode,
    "reconnecting",
  );
});
test("natural point is preceding containing sentence, not fixed seconds", () => {
  assert.equal(
    resumeAnchor(
      [anchor, { ...anchor, id: "b", startMs: 8100, endMs: 14000 }],
      4500,
    )?.startMs,
    1000,
  );
  assert.equal(resumeAnchor([anchor], 8050)?.startMs, 1000);
});
test("resume intent is conservative", () => {
  for (const t of [
    "继续吧",
    "没有其他问题了",
    "好，继续听",
    "resume playback",
    "continue",
    "go on",
    "Okay, continue.",
    "please go on",
    "continue, please",
    "resume the podcast",
    "Let’s get back to the podcast.",
    "Could you resume the podcast, please?",
    "Thanks, go on.",
    "回到节目吧",
    "好的，继续播放节目",
  ])
    assert.equal(explicitResume(t), true, t);
  for (const t of [
    "懂了",
    "继续解释一下",
    "不要继续",
    "他说继续吧是什么意思",
    "yes",
    "continue explaining",
    "do not continue",
    "go on about that topic",
    "Can you continue explaining that?",
    "continue, actually wait",
    "他说 go on 是什么意思",
    "I said continue but now I have another question",
    "don’t resume the podcast",
    "继续讲讲这个概念",
    "先别继续播放",
    "为什么不继续播放",
    "好，继续，但是我还有一个问题",
  ])
    assert.equal(explicitResume(t), false, t);
});
test("voice is duration weighted, not speaker count", () => {
  assert.equal(
    selectVoice([
      { id: "a", presentation: "feminine", durationMs: 100, confidence: 1 },
      { id: "b", presentation: "feminine", durationMs: 100, confidence: 1 },
      { id: "c", presentation: "masculine", durationMs: 1000, confidence: 1 },
    ]).voice,
    "masculine",
  );
});

test("the resume point never rewinds further than twelve seconds", () => {
  const long = { ...anchor, startMs: 0, endMs: 60000 };
  const passages = [0, 20000, 36000, 44000].map((startMs, i) => ({
    id: `p${i}`,
    startMs,
    endMs: startMs + 8000,
    text: "",
    speaker: "A",
  }));
  // Within the cap the semantic anchor stands.
  assert.equal(resumePoint({ anchors: [long], passages }, 9000)?.startMs, 0);
  // Beyond it, the earliest passage start within twelve seconds.
  assert.equal(resumePoint({ anchors: [long], passages }, 47000)?.startMs, 36000);
  assert.equal(resumePoint({ anchors: [long], passages }, 47000)?.id, "a");
  // No passage starts within the cap: rewind exactly twelve seconds.
  assert.equal(resumePoint({ anchors: [long], passages: [] }, 47000)?.startMs, 35000);
});
test("utterance length counts words and Han characters", () => {
  assert.equal(utteranceUnits("yeah sure"), 2);
  assert.equal(utteranceUnits("这是什么意思"), 6);
  assert.equal(utteranceUnits("GPT 是什么"), 4);
  assert.equal(utteranceUnits("  ,. "), 0);
});
