import { z } from "zod";
import { playerCommandSchema, playerConfigSchema } from "./player.js";

export const turnSchema = z.object({
  id: z.string().optional(),
  role: z.enum(["user", "assistant"]),
  text: z.string().max(12000),
});
const historySchema = z.array(turnSchema).max(100);
const positionSchema = z.number().finite().nonnegative();
const revisionSchema = z.number().int().nonnegative();
export const playerInputSchema = z.object({
  turnId: z.string().min(1).max(100),
  source: z.enum(["text", "voice"]),
  positionMs: positionSchema,
  wasPlaying: z.boolean(),
  audibleSource: z.enum(["podcast", "assistant", "none"]),
  config: playerConfigSchema,
  handledText: z.string().max(12000).optional(),
});
export type PlayerInput = z.infer<typeof playerInputSchema>;
const playbackContextSchema = z.object({
  mode: z.enum([
    "paused",
    "playing",
    "listening",
    "answering",
    "awaiting_followup",
    "resuming",
    "reconnecting",
  ]),
  interrupted: z.boolean(),
  resumeMs: positionSchema.optional(),
});
/** Only output admitted to the client's answer audio window; never a planned reply. */
export const spokenReplySchema = z.object({
  decisionId: z.string().min(1).max(100),
  text: z.string().max(12000),
  // Quiet is only observed audio inactivity; GPT-Live has no per-reply done event.
  state: z.enum(["queued", "speaking", "quiet", "finished", "interrupted"]),
});
export type SpokenReply = z.infer<typeof spokenReplySchema>;
/** Browser-owned playback state, not a transcript or an intent request. */
export const livePlayerStateSchema = playerInputSchema
  .omit({
    turnId: true,
    source: true,
    handledText: true,
  })
  .extend({
    version: revisionSchema,
    sequence: revisionSchema,
    revision: revisionSchema,
    playback: playbackContextSchema.optional(),
    assistant: spokenReplySchema.optional(),
  });
export type LivePlayerState = z.infer<typeof livePlayerStateSchema>;
export const playerCommandsSchema = z.array(playerCommandSchema).min(1).max(4);
const observedPlayerSchema = livePlayerStateSchema.omit({
  assistant: true,
  version: true,
  sequence: true,
  revision: true,
});
export const conversationContextSchema = z.object({
  playback: observedPlayerSchema,
  assistant: spokenReplySchema.omit({ text: true }).optional(),
  recentActions: z
    .array(
      z.object({
        decisionId: z.string(),
        commands: playerCommandsSchema,
        accepted: z.boolean(),
        observed: observedPlayerSchema,
      }),
    )
    .max(4),
});
export type ConversationContext = z.infer<typeof conversationContextSchema>;
export const questionSchema = z.object({
  atMs: positionSchema,
  revision: revisionSchema,
  history: historySchema,
  player: playerInputSchema.optional(),
  conversation: conversationContextSchema.optional(),
});
export const liveSchema = z.object({
  history: historySchema.default([]),
  sdp: z.string().min(1).max(64000),
  atMs: positionSchema,
  control: z
    .object({
      player: livePlayerStateSchema,
      debug: z.boolean().default(false),
    })
    .optional(),
});
export const checkpointSchema = z.object({
  version: z.number().int().nonnegative().optional(),
  positionMs: positionSchema,
  resumeMs: positionSchema.optional(),
  history: historySchema,
});
export const sourceSchema = z.object({
  text: z.string(),
  startMs: positionSchema.optional(),
  url: z.string().url().optional(),
});
const answerFields = {
  revision: revisionSchema,
  answer: z.string(),
  sources: z.array(sourceSchema),
  tools: z.array(z.string()),
};
export const questionResultSchema = z.discriminatedUnion("action", [
  z.object({ ...answerFields, action: z.literal("answer") }),
  z.object({ ...answerFields, action: z.literal("resume") }),
  z.object({ ...answerFields, action: z.literal("ignore") }),
  z.object({ ...answerFields, action: z.literal("wait") }),
  z.object({
    ...answerFields,
    action: z.literal("player_control"),
    commandId: z.string().min(1).max(240),
    commands: playerCommandsSchema,
    followUpQuestion: z.string().trim().min(1).max(2000).optional(),
  }),
]);
export const questionPhaseSchema = z.enum([
  "working",
  "searching",
  "continuing",
]);
export const errorSchema = z.object({ error: z.string() });
export const questionEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("answer"),
    revision: revisionSchema,
    text: z.string().max(64000),
  }),
  z.object({
    type: z.literal("progress"),
    revision: revisionSchema,
    phase: questionPhaseSchema,
  }),
  z.object({ type: z.literal("result"), result: questionResultSchema }),
  z.object({ type: z.literal("error"), error: z.string() }),
]);
export type Turn = z.infer<typeof turnSchema>;
export type QuestionRequest = z.infer<typeof questionSchema>;
export type QuestionResult = z.infer<typeof questionResultSchema>;
export type QuestionPhase = z.infer<typeof questionPhaseSchema>;
export type QuestionEvent = z.infer<typeof questionEventSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type Checkpoint = z.infer<typeof checkpointSchema>;
export type LiveRequest = z.infer<typeof liveSchema>;
export const liveControlUpdateSchema = z.object({
  sessionId: z.string().min(1).max(200),
  player: livePlayerStateSchema,
  acknowledgement: z
    .object({ decisionId: z.string().min(1).max(100), applied: z.boolean() })
    .optional(),
});
export type LiveControlUpdate = z.infer<typeof liveControlUpdateSchema>;
/** Supplier session time, independent of the podcast playhead or packet arrival. */
export interface TranscriptTiming {
  startMs: number;
  endMs: number;
}
const liveInputMarkerSchema = z.object({
  turnId: z.string().min(1).max(100),
  startMs: positionSchema.optional(),
});
export type LiveInputMarker = z.infer<typeof liveInputMarkerSchema>;
export const liveControlEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), sessionId: z.string() }),
  z.object({ type: z.literal("heartbeat") }),
  z.object({
    type: z.literal("observing"),
    version: revisionSchema,
    input: liveInputMarkerSchema.optional(),
    text: z.string().optional(),
  }),
  z.object({
    type: z.literal("classifying"),
    version: revisionSchema,
    input: liveInputMarkerSchema.optional(),
    text: z.string().optional(),
    conversation: conversationContextSchema
      .extend({ history: historySchema })
      .optional(),
  }),
  z.object({
    type: z.literal("decision"),
    version: revisionSchema,
    input: liveInputMarkerSchema.optional(),
    decisionId: z.string(),
    player: playerInputSchema,
    text: z.string(),
    result: questionResultSchema,
  }),
  z.object({ type: z.literal("error"), error: z.string() }),
  z.object({ type: z.literal("closed") }),
]);
export type LiveControlEvent = z.infer<typeof liveControlEventSchema>;
export interface LiveResult {
  session: { id: string };
  transport: { sdp: string };
  control?: boolean;
}
