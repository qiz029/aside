import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAIProvider } from "../backend/src/provider.js";
import type { QuestionModel } from "../backend/src/question-model.js";

test("OpenAI adapter maps question input, tool output, citations and cancellation", async (t) => {
  const provider = new OpenAIProvider("test-placeholder", "test-model");
  const abort = new AbortController();
  const inputs: unknown[] = [];
  const calls = t.mock.method(
    provider.client.responses,
    "create",
    async (body: unknown, options: { signal?: AbortSignal }) => {
      inputs.push(body);
      assert.equal(options.signal, abort.signal);
      return {
        id: "response-1",
        output_text: "回答",
        output: [
          { type: "web_search_call" },
          {
            type: "function_call",
            call_id: "call-1",
            name: "search_podcast",
            arguments: '{"query":"词语"}',
          },
          {
            type: "message",
            content: [
              {
                type: "output_text",
                annotations: [
                  {
                    type: "url_citation",
                    title: "Source",
                    url: "https://example.com/source",
                  },
                ],
              },
            ],
          },
        ],
      };
    },
  );
  const request: Parameters<QuestionModel["reply"]>[0] = {
    instructions: "政策",
    tools: [],
    toolResults: [],
    signal: abort.signal,
    context: {
      playheadMs: 10,
      currentPassage: null,
      recentTranscript: [],
      earlierExcerpts: [],
      hostStyle: "",
      history: [],
    },
  };
  const result = await provider.reply(request);
  assert.deepEqual(result, {
    id: "response-1",
    model: "test-model",
    // The mock reports no tier, so nothing is claimed about how it was served.
    serviceTier: null,
    answer: "回答",
    searchedWeb: true,
    sources: [{ text: "Source", url: "https://example.com/source" }],
    calls: [
      { id: "call-1", name: "search_podcast", arguments: '{"query":"词语"}' },
    ],
  });
  assert.deepEqual(inputs[0], {
    model: "test-model",
    instructions: "政策",
    input: [{ role: "user", content: JSON.stringify(request.context) }],
    previous_response_id: undefined,
    tools: [],
    max_output_tokens: 10000,
    reasoning: { effort: "medium" },
    service_tier: "priority",
    parallel_tool_calls: false,
  });
  await provider.reply({
    ...request,
    context: undefined,
    previousId: "response-1",
    toolResults: [{ callId: "call-1", value: { text: "已经听过" } }],
  });
  assert.deepEqual((inputs[1] as { input: unknown }).input, [
    {
      type: "function_call_output",
      call_id: "call-1",
      output: '{"text":"已经听过"}',
    },
  ]);
  assert.equal(calls.mock.callCount(), 2);
});

test("the fast admission round uses required tools and low reasoning while ordinary answers keep their settings", async (t) => {
  const provider = new OpenAIProvider("test-placeholder", "test-model");
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(provider.client.responses, "create", async (body: unknown) => {
    bodies.push(body as Record<string, unknown>);
    return { id: "r", output_text: "", output: [] };
  });
  await provider.reply({
    instructions: "Decide",
    tools: [],
    toolResults: [],
    reasoningEffort: "low",
    toolChoice: "required",
  });
  await provider.reply({ instructions: "Answer", tools: [], toolResults: [] });
  assert.deepEqual(bodies[0].reasoning, { effort: "low" });
  assert.equal(bodies[0].tool_choice, "required");
  assert.deepEqual(bodies[1].reasoning, { effort: "medium" });
  assert.equal(bodies[1].tool_choice, undefined);
});

test("the served tier and token usage come back with the reply", async (t) => {
  const provider = new OpenAIProvider("test-placeholder", "test-model");
  t.mock.method(provider.client.responses, "create", async () => ({
    id: "response-1",
    // Asked for priority, served as standard: a ramp-rate downgrade.
    service_tier: "default",
    output_text: "回答",
    output: [],
    usage: {
      input_tokens: 4200,
      input_tokens_details: { cached_tokens: 3000, cache_write_tokens: 0 },
      output_tokens: 900,
      output_tokens_details: { reasoning_tokens: 780 },
      total_tokens: 5100,
    },
  }));
  const reply = await provider.reply({
    instructions: "政策",
    tools: [],
    toolResults: [],
  });
  assert.equal(reply.model, "test-model");
  assert.equal(reply.serviceTier, "default");
  assert.deepEqual(reply.usage, {
    inputTokens: 4200,
    cachedInputTokens: 3000,
    outputTokens: 900,
    reasoningTokens: 780,
  });
});

test("an exhausted output budget fails instead of resolving to a silent answer", async (t) => {
  const { InteractiveProvider } =
    await import("../backend/src/interactive-provider.js");
  const request: Parameters<QuestionModel["reply"]>[0] = {
    instructions: "政策",
    tools: [],
    toolResults: [],
    context: {
      playheadMs: 0,
      currentPassage: null,
      recentTranscript: [],
      earlierExcerpts: [],
      hostStyle: "",
      history: [],
    },
  };
  for (const [trial, budget] of [
    [false, 10000],
    [true, 6000],
  ] as const) {
    const provider = new InteractiveProvider(
      "test-placeholder",
      "test-model",
      trial,
    );
    const bodies: { max_output_tokens: number }[] = [];
    t.mock.method(
      provider.client.responses,
      "create",
      async (body: { max_output_tokens: number }) => {
        bodies.push(body);
        // Reasoning consumed the budget: no message and no tool call.
        return {
          id: "response-1",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output_text: "",
          output: [],
        };
      },
    );
    await assert.rejects(provider.reply(request), /max_output_tokens/);
    assert.equal(bodies[0].max_output_tokens, budget);
  }
});

test("Live session setup keeps native audio and client delegation, with silent playback control policy", async (t) => {
  const { InteractiveProvider, LiveCreationRejected } =
    await import("../backend/src/interactive-provider.js");
  const provider = new InteractiveProvider("test-placeholder");
  const analysis = {
    version: "1",
    source: "demo" as const,
    passages: [],
    anchors: [],
    summary: "",
    hostStyle: "brief",
    speakers: [],
    voice: "feminine" as const,
    voiceReason: "test",
  };
  let status = 200;
  let body: any;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://api.openai.com/v1/live/sessions");
    body = JSON.parse(init.body as string);
    return Response.json(
      { session: { id: "live-test" }, transport: { sdp: "answer" } },
      { status },
    );
  });
  const result = await provider.createLive("offer", analysis, 1000, [
    { role: "user", text: "Earlier question" },
    { role: "assistant", text: "Earlier answer" },
  ]);
  assert.equal(result.session.id, "live-test");
  assert.equal(body.session.model, "gpt-live-1");
  assert.deepEqual(body.session.delegation, { type: "client" });
  assert.deepEqual(body.transport, { type: "webrtc", sdp: "offer" });
  assert.equal(body.session.audio.output.voice, "gleam");
  assert.match(body.session.instructions, /"wait wait"/);
  assert.match(body.session.instructions, /complete pause requests/);
  assert.match(
    body.session.instructions,
    /Ignore speech addressed to other people/,
  );
  assert.match(
    body.session.instructions,
    /as soon as the actionable intent is clear/,
  );
  assert.match(
    body.session.instructions,
    /Do not claim any playback operation succeeded/,
  );
  await provider.createLive("offer", { ...analysis, voice: "masculine" }, 0);
  assert.equal(body.session.audio.output.voice, "meridian");
  for (const code of [400, 408, 503]) {
    status = code;
    await assert.rejects(
      provider.createLive("offer", analysis, 0),
      code === 400 ? LiveCreationRejected : /Live session creation failed/,
    );
  }
});

test("the recorded-audio fallback forwards cancellation, and trial requests filter expensive tools", async (t) => {
  const { InteractiveProvider } =
    await import("../backend/src/interactive-provider.js");
  const provider = new InteractiveProvider(
    "test-placeholder",
    "test-model",
    true,
  );
  const signal = new AbortController().signal;
  t.mock.method(
    provider.client.audio.transcriptions,
    "create",
    async (body: any, options: any) => {
      assert.equal(body.model, "whisper-1");
      assert.equal(options.signal, signal);
      return { text: "pause" };
    },
  );
  assert.equal(
    await provider.transcribeQuestion(Buffer.from("wav"), signal),
    "pause",
  );
  t.mock.method(provider.client.responses, "create", async (body: any) => {
    assert.deepEqual(body.tools, []);
    assert.equal(body.parallel_tool_calls, false);
    return { id: "response", output_text: "", output: [] };
  });
  const context = {
    playheadMs: 0,
    currentPassage: null,
    recentTranscript: [],
    earlierExcerpts: [],
    hostStyle: "",
    history: [],
  };
  await provider.reply({
    context,
    instructions: "",
    toolResults: [],
    tools: [{ type: "web_search" }],
  });
  await assert.rejects(
    provider.reply({
      context: { ...context, hostStyle: "x".repeat(33000) },
      instructions: "",
      toolResults: [],
      tools: [],
    }),
    /Trial context too large/,
  );
});

test("OpenAI text streaming exposes real SDK deltas before the final response", async (t) => {
  const { streamedResponse } = await import("./fixtures/streamed-response.js");
  const provider = new OpenAIProvider("test-placeholder", "test-model");
  const received: string[] = [];
  t.mock.method(
    provider.client.responses,
    "create",
    async (body: any, options: any) => {
      assert.equal(body.stream, true);
      const OpenAI = (await import("openai")).default;
      const client = new OpenAI({
        apiKey: "fixture",
        fetch: async () => streamedResponse("Hello world", 10),
      });
      return client.responses.create(body, options);
    },
  );
  let resolved = false;
  const pending = provider
    .reply({
      instructions: "test",
      tools: [],
      toolResults: [],
      onText(delta) {
        assert.equal(resolved, false);
        received.push(delta);
      },
    })
    .then((result) => {
      resolved = true;
      return result;
    });
  const result = await pending;
  assert.ok(received.length > 1);
  assert.equal(received.join(""), "Hello world");
  assert.equal(result.answer, "Hello world");
});
