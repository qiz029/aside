import type { buildContext } from "@aside/engine/server";
import type {
  Source,
  PlayerInput,
  ConversationContext,
} from "@aside/engine/contracts";
export type QuestionTool =
  | { type: "web_search" }
  | {
      type: "function";
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      strict: boolean;
    };
export interface ToolResult {
  callId: string;
  value: unknown;
}
/** Billable counts for one round, in this app's terms rather than the SDK's. */
export interface ModelUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}
export interface ModelReply {
  id: string;
  /** Which model served the round, so telemetry survives an env override. */
  model?: string;
  answer: string;
  sources: Source[];
  searchedWeb: boolean;
  calls: { id: string; name: string; arguments: string }[];
  /**
   * Tier that actually served the request, not the one asked for: a ramp-rate
   * downgrade reports "default" while the request still succeeds. Absent when
   * the provider does not report one.
   */
  serviceTier?: string | null;
  usage?: ModelUsage;
}
/** Only the data needed by this app's question loop, with no SDK types. */
export interface QuestionModel {
  reply(request: {
    context?: ReturnType<typeof buildContext> & {
      player?: PlayerInput;
      conversation?: ConversationContext;
    };
    previousId?: string;
    toolResults: ToolResult[];
    instructions: string;
    tools: QuestionTool[];
    signal?: AbortSignal;
    onText?: (delta: string) => void;
  }): Promise<ModelReply>;
}
