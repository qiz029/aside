import OpenAI, { toFile } from "openai";
import { z } from "zod";
import { liveStartupHistory } from "@aside/engine/server";
import type { Analysis, Turn } from "@aside/engine/core";
import type { QuestionModel, ModelReply } from "./question-model.js";
import {
  ResponsesPreload,
  contextDelta,
  type ConnectResponses,
} from "./response-preload.js";
import {
  hostPerspective,
  playerInteractionInstructions,
} from "./dialogue-policy.js";

export class LiveCreationRejected extends Error {}

/**
 * The cap covers reasoning tokens as well as the reply, so it is headroom for
 * the model to think rather than a length limit on the answer: spoken length is
 * bounded by the dialogue policy (180 words / 350 Chinese characters per turn).
 * A turn that actually reaches this many tokens hits the caller's 60s abort
 * first, so raising it further buys nothing.
 */
const OUTPUT_TOKENS = 10000;
/** Anonymous trial turns are rate limited per day, but still get room to reason. */
const TRIAL_OUTPUT_TOKENS = 6000;
/** Spoken answers are short; effort buys better tool and intent decisions. */
const REASONING_EFFORT = "medium" as const;
/**
 * Fast mode. `"fast"` and `"priority"` are documented as identical, and the
 * pinned SDK's union has only the latter, so this spelling is the one that type
 * checks. No subscription: it is pay-as-you-go at a per-token premium (twice
 * the standard rate for the GPT-5.6 family), which is why a listener waiting
 * mid-episode justifies it and batch analysis does not. Support is not
 * guaranteed for every model, and ramp-rate limits downgrade a request
 * silently — the response's own `service_tier` says which tier served it.
 */
const SERVICE_TIER = "priority" as const;

/** Network-only adapter, shared by Workers and the local Node server. */
export class InteractiveProvider implements QuestionModel {
  readonly client: OpenAI;
  constructor(
    key: string,
    readonly model = "gpt-5.6-luna",
    readonly trial = false,
    private connectResponses?: ConnectResponses,
  ) {
    this.client = new OpenAI({ apiKey: key, maxRetries: 0, timeout: 90000 });
  }
  prepareLive(request: Parameters<QuestionModel["reply"]>[0]) {
    if (!this.connectResponses || !request.context) return;
    const base = request.context;
    const preload = new ResponsesPreload(
      this.parameters(request),
      this.connectResponses,
    );
    return {
      model: {
        reply: (input: Parameters<QuestionModel["reply"]>[0]) =>
          this.replyPrepared(input, preload, base),
      },
      close: () => preload.close(),
    };
  }
  async reply(
    request: Parameters<QuestionModel["reply"]>[0],
  ): Promise<ModelReply> {
    return this.replyPrepared(request);
  }
  private parameters(request: Parameters<QuestionModel["reply"]>[0]) {
    const input: OpenAI.Responses.ResponseInput = request.context
      ? [{ role: "user", content: JSON.stringify(request.context) }]
      : request.toolResults.map((result) => ({
          type: "function_call_output",
          call_id: result.callId,
          output: JSON.stringify(result.value),
        }));
    if (
      this.trial &&
      new TextEncoder().encode(JSON.stringify(input)).length > 32000
    )
      throw Error("Trial context too large");
    return {
      model: this.model,
      instructions: request.instructions,
      input,
      previous_response_id: request.previousId,
      tools: this.trial
        ? request.tools.filter((tool) => tool.type !== "web_search")
        : request.tools,
      max_output_tokens: this.trial ? TRIAL_OUTPUT_TOKENS : OUTPUT_TOKENS,
      reasoning: { effort: request.reasoningEffort ?? REASONING_EFFORT },
      ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
      service_tier: SERVICE_TIER,
      parallel_tool_calls: false,
    } satisfies OpenAI.Responses.ResponseCreateParamsNonStreaming;
  }
  private async replyPrepared(
    request: Parameters<QuestionModel["reply"]>[0],
    preload?: ResponsesPreload,
    base?: NonNullable<Parameters<QuestionModel["reply"]>[0]["context"]>,
  ): Promise<ModelReply> {
    request.signal?.throwIfAborted();
    const parameters = this.parameters(request);
    // Facts still use their existing independent HTTP continuation. A slow
    // answer must never occupy the warmed intent connection's active lane.
    const prepared =
      preload && request.toolChoice === "required"
        ? await preload.reply(
            {
              ...parameters,
              input: request.context
                ? [
                    {
                      role: "user",
                      content: JSON.stringify(
                        contextDelta(base!, request.context),
                      ),
                    },
                  ]
                : parameters.input,
            },
            request.signal,
          )
        : undefined;
    request.signal?.throwIfAborted();
    if (preload && request.toolChoice === "required")
      console.log("Aside voice model preload", {
        state: prepared ? "used" : "fallback",
      });
    const response =
      prepared ??
      (request.onText
        ? await this.client.responses
            .stream(parameters, { signal: request.signal })
            .on("response.output_text.delta", (event) =>
              request.onText?.(event.delta),
            )
            .finalResponse()
        : await this.client.responses.create(parameters, {
            signal: request.signal,
          }));
    // Reasoning shares the output budget, so an exhausted turn can carry neither
    // an answer nor a tool call. Failing here reaches the caller's error path
    // instead of resolving to an empty answer that nothing ever speaks.
    if (response.status === "incomplete")
      throw Error(
        `Model reply incomplete (${response.incomplete_details?.reason ?? "unknown"})`,
      );
    const sources: ModelReply["sources"] = [];
    const calls: ModelReply["calls"] = [];
    let searchedWeb = false;
    for (const item of response.output) {
      if (item.type === "web_search_call") searchedWeb = true;
      if (item.type === "function_call")
        calls.push({
          id: item.call_id,
          name: item.name,
          arguments: item.arguments,
        });
      if (item.type === "message")
        for (const content of item.content)
          if (content.type === "output_text")
            for (const annotation of content.annotations)
              if (annotation.type === "url_citation")
                sources.push({ text: annotation.title, url: annotation.url });
    }
    return {
      id: response.id,
      model: this.model,
      answer:
        response.output_text ??
        response.output
          .flatMap((item) =>
            item.type === "message"
              ? item.content
                  .filter((part) => part.type === "output_text")
                  .map((part) => part.text)
              : [],
          )
          .join(""),
      sources,
      calls,
      searchedWeb,
      serviceTier: response.service_tier ?? null,
      ...(response.usage
        ? {
            usage: {
              inputTokens: response.usage.input_tokens,
              cachedInputTokens:
                response.usage.input_tokens_details.cached_tokens,
              outputTokens: response.usage.output_tokens,
              reasoningTokens:
                response.usage.output_tokens_details.reasoning_tokens,
            },
          }
        : {}),
    };
  }
  async transcribeQuestion(audio: Buffer, signal?: AbortSignal) {
    const result = await this.client.audio.transcriptions.create(
      {
        model: "whisper-1",
        file: await toFile(audio, "question.wav", { type: "audio/wav" }),
        response_format: "json",
      },
      { signal },
    );
    return result.text;
  }
  async createLive(
    sdp: string,
    a: Analysis,
    atMs: number,
    history: Turn[] = [],
  ) {
    const response = await fetch("https://api.openai.com/v1/live/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.client.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session: {
          model: "gpt-live-1",
          input: liveStartupHistory(history).map((t) => ({
            type: "message",
            role: t.role,
            content: [
              {
                type: t.role === "assistant" ? "output_text" : "input_text",
                text: t.text,
              },
            ],
          })),
          delegation: { type: "client" },
          audio: {
            output: { voice: a.voice === "feminine" ? "gleam" : "meridian" },
          },
          instructions:
            hostPerspective +
            playerInteractionInstructions +
            "Wait silently at startup. Do not greet or answer old history. Listen during podcast playback, but do not speak over it. Ignore speech addressed to other people. Delegate addressed playback requests and substantive questions as soon as the actionable intent is clear, even while the user continues speaking. Remain silent until the app accepts an addressed question; the app controls whether playback pauses. Once the app reports that the spoken turn is accepted, you may acknowledge briefly while the backend prepares its answer. Wait for backend facts before explaining, and do not invent a lookup or fill pauses repeatedly. If the app says a local recording is being handled, wait for its backend result instead of duplicating it. Determine spoken reply language ONLY from the latest actual user utterance or their explicit language request. English questions MUST receive spoken English answers; Chinese questions receive Chinese answers. Host style, metadata, control messages, summaries and previous assistant replies do not determine reply language. Preserve the language and concise length of backend answers instead of translating or expanding them. For simple questions use 2-3 short spoken sentences; expand only when asked or needed. No markdown, lists, greetings, repeated questions or automatic follow-up invitations. Let the app manage playback and follow-up waiting. Delegate factual questions and all playback requests (including rate, volume, mute, pause, seek and repeat) to the backend. Remain available for follow-ups. Never interpret silence as permission to resume. If a lookup takes time give at most one brief concrete progress update. Host style: " +
            a.hostStyle +
            " Initial playhead ms: " +
            atMs,
        },
        transport: { type: "webrtc", sdp },
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408
      )
        throw new LiveCreationRejected(
          `Live session rejected (${response.status})`,
        );
      throw Error(`Live session creation failed (${response.status})`);
    }
    return z
      .object({
        session: z.object({ id: z.string() }),
        transport: z.object({ sdp: z.string() }),
      })
      .parse(await response.json());
  }
}
