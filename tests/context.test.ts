import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeAnalysis,
  searchPodcast,
  getPassage,
  buildContext,
} from "@aside/engine/server";
const ps = [
  {
    id: "1",
    startMs: 0,
    endMs: 3000,
    text: "散步会给思考留下空间。",
    speaker: "a",
  },
  {
    id: "2",
    startMs: 3000,
    endMs: 6000,
    text: "后面的答案是收购。",
    speaker: "a",
  },
];
const a = makeAnalysis(ps, {
  summary: "future facts",
  hostStyle: "plain",
  speakers: [],
  groups: [
    { firstId: "1", lastId: "2" },
    { firstId: "missing", lastId: "2" },
  ],
});
test("lookup excludes future and partially heard passages", () => {
  assert.equal(searchPodcast(a, "收购", 4000).length, 0);
  assert.equal(searchPodcast(a, "散步", 4000).length, 1);
  assert.deepEqual(
    getPassage(a, 3000, 4000).map((p) => p.id),
    ["1"],
  );
});
test("context does not leak global future summary and labels current partial text", () => {
  const c = buildContext(a, 4000, []);
  assert.equal(c.currentPassage?.partiallyHeard, true);
  assert.equal(JSON.stringify(c).includes("future facts"), false);
  assert.equal(c.recentTranscript.length, 1);
});
test("analysis rejects fabricated boundaries and covers real segments", () => {
  assert.equal(a.anchors.length, 1);
  assert.equal(a.anchors[0].startMs, 0);
  assert.equal(a.anchors[0].endMs, 6000);
});

test("new Live session keeps recent roles and bounds multilingual history", async () => {
  const { liveStartupHistory } = await import("@aside/engine/server");
  const history = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 ? ("assistant" as const) : ("user" as const),
    text: `${i} 中文😀`.repeat(300),
  }));
  const selected = liveStartupHistory(history, 1000);
  assert.ok(
    new TextEncoder().encode(selected.map((t) => t.text).join("")).length <=
      1000,
  );
  assert.equal(selected.at(-1)?.role, "assistant");
  assert.ok(selected.at(-1)?.text.startsWith("19"));
  assert.ok(!selected.some((t) => t.text.startsWith("0 ")));
});

test("the model never sees stored passage bulk such as word timings", () => {
  const bulky = makeAnalysis(
    ps.map((p) => ({
      ...p,
      words: Array.from({ length: 40 }, (_, i) => ({
        text: `w${i}`,
        startMs: p.startMs + i * 50,
        endMs: p.startMs + i * 50 + 40,
      })),
    })),
    { summary: "", hostStyle: "plain", speakers: [], groups: [] },
  );
  const c = buildContext(bulky, 4000, []);
  for (const value of [
    c,
    getPassage(bulky, 3000, 4000),
    searchPodcast(bulky, "散步", 4000),
  ])
    assert.equal(JSON.stringify(value).includes("words"), false);
  assert.deepEqual(Object.keys(c.recentTranscript[0]).sort(), [
    "endMs",
    "id",
    "speaker",
    "startMs",
    "text",
  ]);
});

test("a long recording with a long conversation still fits the request budget", () => {
  const long = makeAnalysis(
    Array.from({ length: 3000 }, (_, i) => ({
      id: `p${i}`,
      startMs: i * 4000,
      endMs: i * 4000 + 4000,
      text: `第${i}段，主持人在这里讲了一个不短的句子，用来撑起上下文体积。`,
      speaker: "host",
    })),
    { summary: "", hostStyle: "x".repeat(3000), speakers: [], groups: [] },
  );
  const history = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 ? ("assistant" as const) : ("user" as const),
    text: `${i} `.padEnd(1500, "回答"),
  }));
  const c = buildContext(long, 2400 * 4000, history);
  assert.ok(new TextEncoder().encode(JSON.stringify(c)).length <= 24000);
  assert.equal(c.currentPassage?.id, "p2400");
  // The newest turns and the passages just before the playhead survive.
  assert.ok(c.history.length >= 4);
  assert.ok(c.history.at(-1)?.text.startsWith("19"));
  assert.equal(c.recentTranscript.at(-1)?.id, "p2399");
});

test("long previous answers cannot prevent the newest question from fitting the model context", () => {
  const history = Array.from({ length: 60 }, (_, i) => ({
    role: i % 2 ? ("assistant" as const) : ("user" as const),
    text: `Turn ${i}: ${"Earlier context. ".repeat(600)}`,
  }));
  history.push({ role: "user", text: "Can you explain your last point?" });
  const original = JSON.stringify(history);
  const context = buildContext(a, 4000, history);
  assert.ok(new TextEncoder().encode(JSON.stringify(context)).length <= 24000);
  assert.deepEqual(context.history.at(-1), history.at(-1));
  assert.deepEqual(context.history.at(-2), history.at(-2));
  assert.equal(context.currentPassage?.id, "2");
  assert.equal(
    JSON.stringify(history),
    original,
    "model selection must not erase the stored conversation",
  );
});
