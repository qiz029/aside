import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeCost,
  QuestionService,
  type QuestionTelemetry,
} from "../backend/src/question-service.js";
import type {
  ModelReply,
  QuestionModel,
} from "../backend/src/question-model.js";
import type { Analysis } from "@aside/engine/core";
import { createPlayerConfig } from "@aside/engine/player";
const analysis: Analysis = {
  version: "test",
  passages: [
    {
      id: "heard",
      startMs: 0,
      endMs: 1000,
      text: "散步 helps thinking",
      speaker: "host",
    },
    {
      id: "future",
      startMs: 2000,
      endMs: 3000,
      text: "散步 future secret",
      speaker: "host",
    },
  ],
  anchors: [],
  speakers: [],
  summary: "future summary",
  hostStyle: "clear",
  voice: "feminine",
  voiceReason: "test",
  source: "demo",
};
const request = {
  revision: 3,
  atMs: 1500,
  history: [{ role: "user" as const, text: "解释散步" }],
};
const reply = (overrides: Partial<ModelReply> = {}): ModelReply => ({
  id: "r",
  answer: "说明",
  sources: [],
  searchedWeb: false,
  calls: [],
  ...overrides,
});
test("question flow executes heard-only tools and combines external citations without an SDK", async () => {
  const inputs: Parameters<QuestionModel["reply"]>[0][] = [];
  const model: QuestionModel = {
    async reply(input) {
      inputs.push(input);
      return inputs.length === 1
        ? reply({
            id: "first",
            calls: [
              {
                id: "search",
                name: "search_podcast",
                arguments: '{"query":"散步"}',
              },
            ],
          })
        : reply({
            sources: [
              { text: "Reference", url: "https://example.com/reference" },
            ],
            searchedWeb: true,
          });
    },
  };
  const phases: string[] = [];
  const result = await new QuestionService(model).answer(
    analysis,
    request,
    undefined,
    (phase) => phases.push(phase),
  );
  assert.deepEqual(result.tools, ["search_podcast", "search_web"]);
  assert.equal(result.sources.length, 2);
  assert.equal(JSON.stringify(inputs).includes("future secret"), false);
  assert.equal(JSON.stringify(inputs).includes("future summary"), false);
  assert.equal(inputs[1].previousId, "first");
  assert.equal(inputs[1].context, undefined);
  assert.deepEqual(
    inputs[1].toolResults.map((result) => result.callId),
    ["search"],
  );
  assert.deepEqual(phases, ["working", "searching", "continuing"]);
});
test("invalid or unknown tool calls return structured errors to the model", async () => {
  let input: Parameters<QuestionModel["reply"]>[0] | undefined;
  let count = 0;
  const model: QuestionModel = {
    async reply(request) {
      if (count++ === 0)
        return reply({
          calls: [
            { id: "bad", name: "get_passage", arguments: '{"atMs":-1}' },
            { id: "json", name: "search_podcast", arguments: "broken" },
            { id: "unknown", name: "unregistered", arguments: "{}" },
          ],
        });
      input = request;
      return reply();
    },
  };
  await new QuestionService(model).answer(analysis, request);
  assert.deepEqual(input?.toolResults, [
    { callId: "bad", value: { error: "Invalid tool arguments" } },
    { callId: "json", value: { error: "Invalid tool arguments" } },
    { callId: "unknown", value: { error: "Unknown tool" } },
  ]);
});
test("casual continuation reaches the conversational model and its resume tool ends the loop", async () => {
  let calls = 0;
  const model: QuestionModel = {
    async reply() {
      calls++;
      return reply({
        calls: [{ id: "resume", name: "resume_podcast", arguments: "{}" }],
      });
    },
  };
  const service = new QuestionService(model);
  assert.equal(
    (
      await service.answer(analysis, {
        ...request,
        history: [{ role: "user", text: "继续" }],
      })
    ).action,
    "resume",
  );
  assert.equal(calls, 1);
  const result = await service.answer(analysis, request);
  assert.equal(result.action, "resume");
  assert.equal(result.answer, "");
  assert.equal(calls, 2);
});
test("tool budget and cancellation stop further model work", async () => {
  let calls = 0;
  const looping: QuestionModel = {
    async reply() {
      calls++;
      return reply({
        calls: [
          { id: "loop", name: "search_podcast", arguments: '{"query":"散步"}' },
        ],
      });
    },
  };
  await assert.rejects(
    new QuestionService(looping).answer(analysis, request),
    /round limit/,
  );
  assert.equal(calls, 5);
  const abort = new AbortController();
  const cancelled: QuestionModel = {
    async reply(input) {
      assert.equal(input.signal, abort.signal);
      abort.abort();
      return reply();
    },
  };
  await assert.rejects(
    new QuestionService(cancelled).answer(analysis, request, abort.signal),
    { name: "AbortError" },
  );
  await assert.rejects(
    new QuestionService(looping).answer(analysis, request, abort.signal),
    { name: "AbortError" },
  );
  assert.equal(calls, 5);
});

test("given a live playback request, controls return in one model round with playback context", async () => {
  const { createPlayerConfig } = await import("@aside/engine/player");
  const player = {
    turnId: "turn-1",
    source: "voice" as const,
    positionMs: 1800,
    wasPlaying: true,
    audibleSource: "podcast" as const,
    config: createPlayerConfig(),
  };
  let calls = 0;
  const model: QuestionModel = {
    async reply(input) {
      calls++;
      assert.deepEqual(input.context?.player, player);
      assert.ok(
        input.tools.some(
          (tool) => tool.type === "function" && tool.name === "control_podcast",
        ),
      );
      return reply({
        calls: [
          {
            id: "control",
            name: "control_podcast",
            arguments: JSON.stringify({
              commands: [
                { type: "adjust_rate", direction: "slower" },
                { type: "repeat" },
              ],
            }),
          },
        ],
      });
    },
  };
  const result = await new QuestionService(model).answer(analysis, {
    ...request,
    player,
  });
  assert.equal(result.action, "player_control");
  if (result.action !== "player_control")
    assert.fail("expected playback command");
  assert.deepEqual(result.commands, [
    { type: "adjust_rate", direction: "slower" },
    { type: "repeat" },
  ]);
  assert.equal(result.commandId, "turn-1:control");
  assert.equal(result.answer, "");
  assert.equal(calls, 1);
});

test("given invalid playback arguments, no partial operation escapes validation", async () => {
  for (const commands of [
    [],
    [{ type: "set_volume", volume: 2 }],
    [{ type: "pause" }, { type: "seek", atMs: "bad" }],
    Array(5).fill({ type: "repeat" }),
  ]) {
    let calls = 0;
    const model: QuestionModel = {
      async reply(input) {
        if (calls++ === 0)
          return reply({
            calls: [
              {
                id: "bad",
                name: "control_podcast",
                arguments: JSON.stringify({ commands }),
              },
            ],
          });
        assert.deepEqual(input.toolResults, [
          { callId: "bad", value: { error: "Invalid tool arguments" } },
        ]);
        return reply();
      },
    };
    assert.equal(
      (await new QuestionService(model).answer(analysis, request)).action,
      "answer",
    );
  }
});

test("given bystander or incomplete speech, the backend returns silence without searching", async () => {
  for (const [name, action] of [
    ["ignore_input", "ignore"],
    ["wait_for_input", "wait"],
  ]) {
    const phases: string[] = [];
    const service = new QuestionService({
      async reply() {
        return reply({ calls: [{ id: "quiet", name, arguments: "{}" }] });
      },
    });
    const result = await service.answer(analysis, request, undefined, (p) =>
      phases.push(p),
    );
    assert.equal(result.action, action);
    assert.equal(result.answer, "");
    assert.deepEqual(phases, ["working"]);
  }
});

test("given an ambient voice saying continue, the model still checks the addressee", async () => {
  const { createPlayerConfig } = await import("@aside/engine/player");
  const result = await new QuestionService({
    async reply() {
      return reply({
        calls: [{ id: "quiet", name: "ignore_input", arguments: "{}" }],
      });
    },
  }).answer(analysis, {
    ...request,
    history: [{ role: "user", text: "continue" }],
    player: {
      turnId: "voice",
      source: "voice",
      positionMs: 0,
      wasPlaying: true,
      audibleSource: "podcast",
      config: createPlayerConfig(),
    },
  });
  assert.equal(result.action, "ignore");
});

test("conflicting terminal decisions cannot execute a control, and excessive tool calls are rejected", async () => {
  let count = 0;
  const service = new QuestionService({
    async reply(input) {
      if (count++ === 0)
        return reply({
          calls: [
            {
              id: "control",
              name: "control_podcast",
              arguments: '{"commands":[{"type":"pause"}]}',
            },
            { id: "ignore", name: "ignore_input", arguments: "{}" },
          ],
        });
      assert.equal(input.toolResults.length, 2);
      assert.ok(
        input.toolResults.every((r) =>
          JSON.stringify(r.value).includes("one decision"),
        ),
      );
      return reply({
        calls: [{ id: "ignore", name: "ignore_input", arguments: "{}" }],
      });
    },
  });
  assert.equal((await service.answer(analysis, request)).action, "ignore");
  await assert.rejects(
    new QuestionService({
      async reply() {
        return reply({
          calls: Array.from({ length: 9 }, (_, i) => ({
            id: String(i),
            name: "get_passage",
            arguments: "{}",
          })),
        });
      },
    }).answer(analysis, request),
    /Tool call limit/,
  );
});

test("a combined request returns its control immediately and preserves the content question", async () => {
  const result = await new QuestionService({
    async reply() {
      return reply({
        calls: [
          {
            id: "mixed",
            name: "control_podcast",
            arguments: JSON.stringify({
              commands: [{ type: "pause" }],
              followUpQuestion: "Why did he say that?",
            }),
          },
        ],
      });
    },
  }).answer(analysis, request);
  assert.equal(result.action, "player_control");
  if (result.action !== "player_control")
    assert.fail("expected remote command");
  assert.equal(result.followUpQuestion, "Why did he say that?");
});

test("cost is reported once per question, summed across rounds", async () => {
  const usage = {
    inputTokens: 1000,
    cachedInputTokens: 400,
    outputTokens: 300,
    reasoningTokens: 250,
  };
  let round = 0;
  const model: QuestionModel = {
    async reply() {
      round++;
      return round === 1
        ? reply({
            model: "test-model",
            serviceTier: "priority",
            usage,
            calls: [
              {
                id: "search",
                name: "search_podcast",
                arguments: '{"query":"散步"}',
              },
            ],
          })
        : // Second round was downgraded: both tiers stay visible.
          reply({ model: "test-model", serviceTier: "default", usage });
    },
  };
  const reports: QuestionTelemetry[] = [];
  await new QuestionService(model).answer(
    analysis,
    request,
    undefined,
    undefined,
    (totals) => reports.push(totals),
  );
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0], {
    model: "test-model",
    rounds: 2,
    tiers: ["priority", "default"],
    inputTokens: 2000,
    cachedInputTokens: 800,
    outputTokens: 600,
    reasoningTokens: 500,
  });
  assert.equal(
    describeCost(reports[0]),
    "test-model rounds=2 tier=priority+default in=2000 cached=800 out=600 reasoning=500",
  );
});

test("a terminal tool return and a thrown round still report what they spent", async () => {
  const spend = {
    model: "test-model",
    serviceTier: "priority" as const,
    usage: {
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 5,
      reasoningTokens: 5,
    },
  };
  const terminal: QuestionModel = {
    async reply() {
      return reply({
        ...spend,
        calls: [{ id: "c", name: "resume_podcast", arguments: "{}" }],
      });
    },
  };
  const reports: QuestionTelemetry[] = [];
  const result = await new QuestionService(terminal).answer(
    analysis,
    request,
    undefined,
    undefined,
    (totals) => reports.push(totals),
  );
  assert.equal(result.action, "resume");
  assert.deepEqual(
    reports.map((r) => [r.rounds, r.outputTokens]),
    [[1, 5]],
  );

  const failing: QuestionModel = {
    async reply() {
      throw Error("upstream exploded");
    },
  };
  const none: QuestionTelemetry[] = [];
  await assert.rejects(
    new QuestionService(failing).answer(
      analysis,
      request,
      undefined,
      undefined,
      (totals) => none.push(totals),
    ),
    /upstream exploded/,
  );
  // Nothing was served, so there is nothing to report.
  assert.deepEqual(none, []);
});

test("text answers expose model deltas before completion and reset tool-round previews", async () => {
  const previews: string[] = [];
  let round = 0;
  const service = new QuestionService({
    async reply(input) {
      if (++round === 1) {
        input.onText?.("Checking a passage");
        assert.equal(previews.at(-1), "Checking a passage");
        return reply({
          calls: [
            {
              id: "search",
              name: "search_podcast",
              arguments: '{"query":"散步"}',
            },
          ],
        });
      }
      assert.equal(previews.at(-1), "");
      input.onText?.("Walking ");
      input.onText?.("helps thinking.");
      assert.equal(previews.at(-1), "Walking helps thinking.");
      return reply({ answer: "Walking helps thinking." });
    },
  });
  const result = await service.answer(
    analysis,
    {
      ...request,
      player: {
        turnId: "typed",
        source: "text",
        positionMs: 1500,
        wasPlaying: false,
        audibleSource: "none",
        config: createPlayerConfig(),
      },
    },
    undefined,
    undefined,
    undefined,
    (text) => previews.push(text),
  );
  assert.equal(result.answer, "Walking helps thinking.");
  assert.deepEqual(previews, [
    "",
    "Checking a passage",
    "",
    "",
    "Walking ",
    "Walking helps thinking.",
  ]);
});

test("conversation and playback tools share the actual spoken history and observed state", async () => {
  let received: Parameters<QuestionModel["reply"]>[0] | undefined;
  const conversation = {
    playback: {
      positionMs: 1500,
      wasPlaying: false,
      audibleSource: "none" as const,
      config: createPlayerConfig(),
      playback: { mode: "awaiting_followup" as const, interrupted: true },
    },
    assistant: { decisionId: "spoken", state: "finished" as const },
    recentActions: [],
  };
  const result = await new QuestionService({
    async reply(input) {
      received = input;
      return reply({
        calls: [{ id: "resume", name: "resume_podcast", arguments: "{}" }],
      });
    },
  }).answer(analysis, {
    ...request,
    conversation,
    history: [
      { role: "assistant", text: "Shall I resume the podcast?" },
      { role: "user", text: "OK" },
    ],
  });
  assert.equal(result.action, "resume");
  assert.deepEqual(received?.context?.conversation, conversation);
  assert.deepEqual(received?.context?.history.at(-2), {
    role: "assistant",
    text: "Shall I resume the podcast?",
  });
  assert.ok(
    received?.tools.some(
      (t) => t.type === "function" && t.name === "control_podcast",
    ),
  );
});
