import { test } from "node:test";
import assert from "node:assert/strict";
import { QuestionService } from "../backend/src/question-service";
import type { QuestionModel, ModelReply } from "../backend/src/question-model";
import type { Analysis } from "@aside/engine/core";
import { createPlayerConfig } from "@aside/engine/player";

const analysis: Analysis = {
  version: "1",
  source: "demo",
  summary: "",
  hostStyle: "",
  speakers: [],
  voice: "feminine",
  voiceReason: "test",
  anchors: [],
  passages: [],
};
const request = {
  atMs: 1000,
  revision: 1,
  history: [{ role: "user" as const, text: "阿Q为什么叫阿Q？" }],
  player: {
    turnId: "q",
    source: "voice" as const,
    positionMs: 1000,
    wasPlaying: true,
    audibleSource: "podcast" as const,
    config: createPlayerConfig(),
  },
};
const reply = (name?: string, args = "{}"): ModelReply => ({
  id: "r",
  answer: name ? "" : "The explanation",
  calls: name ? [{ id: "c", name, arguments: args }] : [],
  sources: [],
  searchedWeb: false,
});
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

test("an explicit fast admission opens the conversation while the full answer is still pending", async () => {
  const inputs: Parameters<QuestionModel["reply"]>[0][] = [];
  let complete!: (r: ModelReply) => void;
  let admitted = 0;
  let finished = false;
  const service = new QuestionService({
    reply: async (input) => {
      inputs.push(input);
      if (inputs.length === 1) return reply("accept_question");
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
  });
  const result = service
    .answer(
      analysis,
      request,
      undefined,
      undefined,
      undefined,
      undefined,
      () => {
        admitted++;
        return true;
      },
    )
    .then((r) => {
      finished = true;
      return r;
    });
  await flush();
  assert.equal(admitted, 1);
  assert.equal(
    finished,
    false,
    "permission does not depend on answer completion",
  );
  assert.equal(inputs[0].reasoningEffort, "low");
  assert.equal(inputs[0].toolChoice, "required");
  assert.equal(
    inputs[0].tools.some((t) => t.type === "web_search"),
    false,
  );
  assert.equal(
    inputs[1].previousId,
    "r",
    "the answer continues the same model conversation",
  );
  assert.equal(
    inputs[1].tools.some(
      (t) => t.type === "function" && t.name === "control_podcast",
    ),
    false,
  );
  complete(reply());
  assert.equal((await result).answer, "The explanation");
});

test("ignore, incomplete speech and player controls never admit a spoken answer or start an answer round", async () => {
  for (const [tool, action, args] of [
    ["ignore_input", "ignore", "{}"],
    ["wait_for_input", "wait", "{}"],
    ["resume_podcast", "resume", "{}"],
    ["control_podcast", "player_control", '{"commands":[{"type":"pause"}]}'],
  ]) {
    let calls = 0;
    const service = new QuestionService({
      reply: async () => {
        calls++;
        return reply(tool, args);
      },
    });
    const result = await service.answer(
      analysis,
      request,
      undefined,
      undefined,
      undefined,
      undefined,
      () => assert.fail("must not admit"),
    );
    assert.equal(result.action, action);
    assert.equal(calls, 1);
  }
});

test("plain text, malformed admission and mixed decisions cannot open the audio gate", async () => {
  for (const invalid of [
    reply(),
    reply("accept_question", '{"unexpected":true}'),
    {
      ...reply("accept_question"),
      calls: [
        ...reply("accept_question").calls,
        ...reply("ignore_input").calls,
      ],
    },
  ]) {
    let calls = 0;
    const service = new QuestionService({
      reply: async () => (++calls === 1 ? invalid : reply("ignore_input")),
    });
    const result = await service.answer(
      analysis,
      request,
      undefined,
      undefined,
      undefined,
      undefined,
      () => assert.fail("invalid decision admitted"),
    );
    assert.equal(result.action, "ignore");
    assert.equal(calls, 2);
  }
});

test("a stale or cancelled admission stops before answer generation", async () => {
  let calls = 0;
  const service = new QuestionService({
    reply: async () => {
      calls++;
      return reply("accept_question");
    },
  });
  await assert.rejects(
    service.answer(
      analysis,
      request,
      undefined,
      undefined,
      undefined,
      undefined,
      () => false,
    ),
    { name: "AbortError" },
  );
  assert.equal(calls, 1);
  const abort = new AbortController();
  await assert.rejects(
    service.answer(
      analysis,
      request,
      abort.signal,
      undefined,
      undefined,
      undefined,
      () => {
        abort.abort();
        return true;
      },
    ),
    { name: "AbortError" },
  );
  assert.equal(calls, 2);
});
