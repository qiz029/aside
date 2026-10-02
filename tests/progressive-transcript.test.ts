import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../backend/src/store.js";
import { createApp } from "../backend/src/app.js";
import { QuestionService } from "../backend/src/question-service.js";
import {
  missingRanges,
  partialAnalysis,
  readTranscriptTool,
} from "../backend/src/transcript-reader.js";
import type { Episode, Passage } from "@aside/engine/core";
const episode: Episode = {
  id: "growing",
  title: "Growing transcript",
  durationMs: 60000,
  createdAt: "now",
  status: "analyzing",
  stage: "transcribing",
  progress: 0.1,
};
const plan = [
  { offsetMs: 0, durationMs: 30000 },
  { offsetMs: 30000, durationMs: 30000 },
];
const passage: Passage = {
  id: "first",
  startMs: 1000,
  endMs: 2000,
  speaker: "host",
  text: "Fresh evidence",
};

test("coverage tracks out-of-order chunks and silence, not the last sentence", () => {
  const a = partialAnalysis(episode, plan, [undefined, []]);
  assert.deepEqual(missingRanges(a, 0, 60000), [{ startMs: 0, endMs: 30000 }]);
  assert.deepEqual(missingRanges(a, 35000, 40000), []);
});

test("a pending lookup resumes with newly committed text and does not expose unheard content", async () => {
  let a = partialAnalysis(episode, plan, [undefined, undefined]);
  const read = await readTranscriptTool(
    a,
    {
      read: async () => a,
      prioritize: async () => {
        a = partialAnalysis(episode, plan, [
          [passage, { ...passage, id: "future", startMs: 15000, endMs: 20000 }],
          undefined,
        ]);
      },
    },
    { atMs: 10000 },
    10000,
  );
  assert.deepEqual(read.passages, [passage]);
  assert.equal((read.value as { status: string }).status, "complete");
});

test("pending and failed ranges are explicit; a canceled lookup stops promptly", async () => {
  const a = partialAnalysis(episode, plan, [undefined, undefined]);
  const result = await readTranscriptTool(
    a,
    undefined,
    { query: "missing" },
    20000,
    undefined,
    0,
  );
  assert.equal((result.value as { status: string }).status, "processing");
  const abort = new AbortController();
  const pending = readTranscriptTool(
    a,
    { read: async () => a, prioritize: async () => {} },
    { atMs: 10000 },
    10000,
    abort.signal,
  );
  setTimeout(() => abort.abort(), 10);
  await assert.rejects(pending, { name: "AbortError" });
  const failed = partialAnalysis({ ...episode, status: "failed" }, plan, [
    undefined,
    [],
  ]);
  assert.equal(
    (await readTranscriptTool(failed, undefined, { atMs: 10000 }, 10000))
      .passages.length,
    0,
  );
});

test("API accepts a question before analysis and tools see chunks written after the model starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "aside-progressive-"));
  const store = new Store(root);
  const unused = async (): Promise<never> => {
    throw Error("Unexpected call");
  };
  let rounds = 0;
  const app = createApp(store, {
    analysis: { transcribe: unused, enrich: unused },
    voice: { createLive: unused, transcribeQuestion: unused },
    questions: new QuestionService({
      reply: async (input) => {
        rounds++;
        if (rounds === 1) {
          store.saveArtifact(episode.id, "transcript-v1-0", [passage]);
          return {
            id: "r1",
            calls: [
              { id: "c1", name: "get_passage", arguments: '{"atMs":10000}' },
            ],
            answer: "",
            sources: [],
            searchedWeb: false,
          };
        }
        assert.equal(
          (input.toolResults[0].value as { passages: Passage[] }).passages[0]
            .text,
          passage.text,
        );
        return {
          id: "r2",
          calls: [],
          answer: "Fresh answer",
          sources: [],
          searchedWeb: false,
        };
      },
    }),
  });
  try {
    await app.ready();
    store.put(episode);
    store.saveArtifact(episode.id, "transcript-plan", plan);
    const response = await app.inject({
      method: "POST",
      url: `/api/episodes/${episode.id}/question`,
      payload: {
        revision: 0,
        atMs: 10000,
        history: [{ role: "user", text: "What did he mean?" }],
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().answer, "Fresh answer");
    assert.equal(store.get(episode.id)?.status, "analyzing");
  } finally {
    await app.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
