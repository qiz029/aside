import { z } from "zod";
import { buildContext, getPassage, searchPodcast } from "@aside/engine/server";
import { type Analysis } from "@aside/engine/core";
import {
  playerCommandsSchema,
  type QuestionRequest,
  type QuestionResult,
  type QuestionPhase,
} from "@aside/engine/contracts";
import type {
  ModelReply,
  QuestionModel,
  ToolResult,
} from "./question-model.js";
import {
  questionInstructions,
  playerToolInstructions,
  liveDecisionInstructions,
} from "./dialogue-policy.js";
import {
  questionTools,
  liveDecisionTools,
  liveAnswerTools,
} from "./question-tools.js";
/**
 * What one question actually cost. `tiers` is per round rather than a single
 * value so a downgrade partway through a tool loop stays visible.
 */
export interface QuestionTelemetry {
  model?: string;
  rounds: number;
  tiers: string[];
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}
/**
 * One compact line for logs: whether fast mode actually served the question
 * (`tier=default` means it was downgraded) and what the turn cost.
 */
export const describeCost = (totals: QuestionTelemetry) =>
  [
    totals.model ?? "model?",
    `rounds=${totals.rounds}`,
    `tier=${totals.tiers.length ? [...new Set(totals.tiers)].join("+") : "unreported"}`,
    `in=${totals.inputTokens}`,
    `cached=${totals.cachedInputTokens}`,
    `out=${totals.outputTokens}`,
    `reasoning=${totals.reasoningTokens}`,
  ].join(" ");
export interface QuestionAnswerer {
  answer(
    analysis: Analysis,
    request: QuestionRequest,
    signal?: AbortSignal,
    progress?: (phase: QuestionPhase) => void,
    telemetry?: (totals: QuestionTelemetry) => void,
    onAnswer?: (text: string) => void,
    onAccept?: () => boolean,
  ): Promise<QuestionResult>;
}
/** Application policy: intent, heard-only retrieval, tool budget and sources. */
export class QuestionService implements QuestionAnswerer {
  constructor(
    private model: QuestionModel,
    private rounds = 5,
  ) {}
  async answer(
    analysis: Analysis,
    request: QuestionRequest,
    signal?: AbortSignal,
    progress?: (phase: QuestionPhase) => void,
    telemetry?: (totals: QuestionTelemetry) => void,
    onAnswer?: (text: string) => void,
    onAccept?: () => boolean,
  ): Promise<QuestionResult> {
    signal?.throwIfAborted();
    const resume = (): QuestionResult => ({
      revision: request.revision,
      answer: "",
      action: "resume",
      sources: [],
      tools: ["resume_podcast"],
    });
    const sources: QuestionResult["sources"] = [],
      used: string[] = [];
    // Accumulated per round and reported once on the way out, including on a
    // terminal tool return or a thrown round: a failed question still spent tokens.
    const totals: QuestionTelemetry = {
      rounds: 0,
      tiers: [],
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    };
    const record = (reply: ModelReply) => {
      totals.rounds++;
      if (reply.model) totals.model = reply.model;
      if (reply.serviceTier) totals.tiers.push(reply.serviceTier);
      if (reply.usage) {
        totals.inputTokens += reply.usage.inputTokens;
        totals.cachedInputTokens += reply.usage.cachedInputTokens;
        totals.outputTokens += reply.usage.outputTokens;
        totals.reasoningTokens += reply.usage.reasoningTokens;
      }
    };
    try {
      return await this.loop(
        analysis,
        request,
        { sources, used },
        resume,
        record,
        signal,
        progress,
        request.player?.source === "text" ? onAnswer : undefined,
        request.player?.source === "voice" ? onAccept : undefined,
      );
    } finally {
      if (totals.rounds) telemetry?.(totals);
    }
  }
  /** The model/tool loop. Extracted only so `answer` can report on every exit. */
  private async loop(
    analysis: Analysis,
    request: QuestionRequest,
    { sources, used }: { sources: QuestionResult["sources"]; used: string[] },
    resume: () => QuestionResult,
    record: (reply: ModelReply) => void,
    signal?: AbortSignal,
    progress?: (phase: QuestionPhase) => void,
    onAnswer?: (text: string) => void,
    onAccept?: () => boolean,
  ): Promise<QuestionResult> {
    let previousId: string | undefined;
    let toolResults: ToolResult[] = [];
    let deciding = !!onAccept;
    for (let round = 0; round < this.rounds + (onAccept ? 1 : 0); round++) {
      signal?.throwIfAborted();
      progress?.(round === 0 ? "working" : "continuing");
      let preview = "";
      onAnswer?.("");
      const response = await this.model.reply({
        context:
          round === 0
            ? {
                ...buildContext(analysis, request.atMs, request.history),
                ...(request.player ? { player: request.player } : {}),
                ...(request.conversation
                  ? { conversation: request.conversation }
                  : {}),
              }
            : undefined,
        previousId,
        toolResults,
        instructions: deciding
          ? liveDecisionInstructions + playerToolInstructions
          : questionInstructions + playerToolInstructions,
        tools: deciding
          ? liveDecisionTools
          : onAccept
            ? liveAnswerTools
            : questionTools,
        ...(deciding
          ? { reasoningEffort: "low" as const, toolChoice: "required" as const }
          : {}),
        signal,
        ...(onAnswer
          ? {
              onText: (delta: string) => {
                if (signal?.aborted) return;
                preview = (preview + delta).slice(0, 64000);
                onAnswer(preview);
              },
            }
          : {}),
      });
      record(response);
      signal?.throwIfAborted();
      previousId = response.id;
      toolResults = [];
      if (response.searchedWeb) used.push("search_web");
      sources.push(...response.sources);
      if (response.calls.length > 8) throw Error("Tool call limit reached");
      if (response.calls.length) onAnswer?.("");
      const terminal = response.calls.some((call) =>
        [
          "control_podcast",
          "resume_podcast",
          "ignore_input",
          "wait_for_input",
        ].includes(call.name),
      );
      if ((terminal || deciding) && response.calls.length > 1) {
        toolResults = response.calls.map((call) => ({
          callId: call.id,
          value: {
            error:
              "Return one decision only; combine playback operations in one control_podcast call",
          },
        }));
        continue;
      }
      for (const call of response.calls) {
        used.push(call.name);
        let result: unknown;
        try {
          const args: unknown = JSON.parse(call.arguments);
          const allowed = deciding
            ? liveDecisionTools
            : onAccept
              ? liveAnswerTools
              : questionTools;
          if (
            !allowed.some(
              (tool) => tool.type === "function" && tool.name === call.name,
            )
          ) {
            toolResults.push({
              callId: call.id,
              value: { error: "Unknown tool" },
            });
            continue;
          }
          if (call.name === "accept_question") {
            z.object({}).strict().parse(args);
            if (!onAccept!())
              throw new DOMException("Admission superseded", "AbortError");
            signal?.throwIfAborted();
            deciding = false;
            toolResults.push({
              callId: call.id,
              value: {
                accepted: true,
                note: "The app is opening the spoken conversation. Prepare the factual answer now; do not repeat an acknowledgement or request admission again.",
              },
            });
            continue;
          }
          if (call.name === "control_podcast") {
            const { commands, followUpQuestion } = z
              .object({
                commands: playerCommandsSchema,
                followUpQuestion: z.string().trim().min(1).max(2000).optional(),
              })
              .strict()
              .parse(args);
            // Terminal result: never spend a second model round narrating a control.
            return {
              revision: request.revision,
              action: "player_control",
              commandId: `${request.player?.turnId ?? request.revision}:${call.id}`,
              commands,
              ...(followUpQuestion ? { followUpQuestion } : {}),
              answer: "",
              sources: [],
              tools: [call.name],
            };
          }
          if (call.name === "ignore_input" || call.name === "wait_for_input") {
            z.object({}).strict().parse(args);
            return {
              revision: request.revision,
              action: call.name === "ignore_input" ? "ignore" : "wait",
              answer: "",
              sources: [],
              tools: [call.name],
            };
          }
          if (call.name === "resume_podcast") {
            z.object({}).strict().parse(args);
            return resume();
          }
          progress?.("searching");
          if (call.name === "get_passage") {
            const { atMs } = z
              .object({ atMs: z.number().finite().nonnegative() })
              .parse(args);
            result = getPassage(analysis, atMs, request.atMs);
          } else if (call.name === "search_podcast") {
            const { query } = z
              .object({ query: z.string().max(2000) })
              .parse(args);
            result = searchPodcast(analysis, query, request.atMs);
          } else result = { error: "Unknown tool" };
          if (Array.isArray(result))
            for (const passage of result)
              sources.push({ text: passage.text, startMs: passage.startMs });
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError")
            throw error;
          result = { error: "Invalid tool arguments" };
        }
        toolResults.push({ callId: call.id, value: result });
      }
      if (!response.calls.length && !deciding)
        return {
          revision: request.revision,
          answer: response.answer,
          action: "answer",
          sources,
          tools: [...new Set(used)],
        };
    }
    throw Error("Tool round limit reached");
  }
}
