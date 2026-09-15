import { z } from "zod";

export const turnSchema = z.object({
  id: z.string().optional(),
  role: z.enum(["user", "assistant"]),
  text: z.string().max(12000),
});
const historySchema = z.array(turnSchema).max(100);
const positionSchema = z.number().finite().nonnegative();
const revisionSchema = z.number().int().nonnegative();
export const questionSchema = z.object({
  atMs: positionSchema,
  revision: revisionSchema,
  history: historySchema,
});
export const liveSchema = z.object({
  history: historySchema.default([]),
  sdp: z.string().min(1).max(64000),
  atMs: positionSchema,
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
export const questionResultSchema = z.object({
  revision: revisionSchema,
  answer: z.string(),
  action: z.enum(["answer", "resume"]),
  sources: z.array(sourceSchema),
  tools: z.array(z.string()),
});
export const questionPhaseSchema = z.enum([
  "working",
  "searching",
  "continuing",
]);
export const errorSchema = z.object({ error: z.string() });
export const questionEventSchema = z.discriminatedUnion("type", [
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
export interface LiveResult {
  session: { id: string };
  transport: { sdp: string };
}
