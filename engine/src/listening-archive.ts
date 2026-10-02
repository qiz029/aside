import { z } from "zod";
import { MAX_AUDIO_DURATION_MS } from "./core.js";

const position = z.number().int().min(0).max(MAX_AUDIO_DURATION_MS);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const episodeId = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9-]+$/);

/** One continuous span of audible podcast playback. Seek/pause ends a span. */
export const listeningEventSchema = z
  .object({
    episodeId,
    sessionId: z.uuid(),
    startedAt: timestamp,
    endedAt: timestamp,
    startMs: position,
    endMs: position,
  })
  .strict()
  .refine(
    (value) =>
      value.endMs > value.startMs &&
      value.endedAt > value.startedAt &&
      value.endedAt - value.startedAt <= 300_000,
    { message: "A playback span must be positive and at most five minutes" },
  );

export const archivedConversationSchema = z
  .object({
    episodeId,
    atMs: position,
  })
  .strict();

/** Only completed/interrupted turns, never speculative or partial model output. */
export const archivedTurnSchema = z
  .object({
    sequence: z.number().int().min(0).max(1_000_000),
    role: z.enum(["user", "assistant"]),
    text: z.string().trim().min(1).max(12_000),
    atMs: position,
    source: z.enum(["text", "voice"]),
    status: z.enum(["completed", "interrupted"]),
    sources: z
      .array(
        z
          .object({
            text: z.string().max(2000),
            startMs: position.optional(),
            url: z.url().max(4096).optional(),
          })
          .strict(),
      )
      .max(20)
      .default([]),
  })
  .strict();

export type ListeningEvent = z.infer<typeof listeningEventSchema>;
export type ArchivedConversation = z.infer<typeof archivedConversationSchema>;
export type ArchivedTurn = z.infer<typeof archivedTurnSchema>;

export interface HeardRange {
  startMs: number;
  endMs: number;
}

/** Union avoids counting replayed spans as additional source coverage. */
export function mergeHeardRanges(ranges: HeardRange[]): HeardRange[] {
  const result: HeardRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.startMs - b.startMs)) {
    const previous = result.at(-1);
    if (previous && range.startMs <= previous.endMs)
      previous.endMs = Math.max(previous.endMs, range.endMs);
    else result.push({ ...range });
  }
  return result;
}
