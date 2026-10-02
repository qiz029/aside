import type { Analysis, Episode, Passage } from "@aside/engine/core";
import { getPassage, searchPodcast } from "@aside/engine/server";

export interface TranscriptReader {
  read(): Promise<Analysis>;
  prioritize(atMs: number): Promise<void>;
}

export function partialAnalysis(
  episode: Episode,
  plan: { offsetMs: number; durationMs: number }[],
  chunks: (Passage[] | undefined)[],
): Analysis {
  const ranges = plan.flatMap((part, i) =>
    chunks[i] === undefined
      ? []
      : [
          {
            startMs: part.offsetMs,
            endMs: part.offsetMs + part.durationMs,
          },
        ],
  );
  const complete = plan.length > 0 && chunks.every((p) => p !== undefined);
  return {
    version: `partial-${ranges.map((r) => r.startMs).join("-")}`,
    passages: chunks
      .flatMap((p) => p ?? [])
      .sort((a, b) => a.startMs - b.startMs),
    anchors: [],
    speakers: [],
    summary: "",
    hostStyle: "",
    voice: "feminine",
    voiceReason: "",
    source: "provider",
    transcript: {
      state: complete
        ? "complete"
        : ["failed", "blocked"].includes(episode.status)
          ? "failed"
          : "processing",
      durationMs: episode.durationMs,
      ranges,
    },
  };
}

export function missingRanges(
  analysis: Analysis,
  startMs: number,
  endMs: number,
) {
  if (!analysis.transcript) return [];
  let cursor = startMs;
  const gaps: { startMs: number; endMs: number }[] = [];
  for (const range of [...analysis.transcript.ranges].sort(
    (a, b) => a.startMs - b.startMs,
  )) {
    if (range.endMs <= cursor || range.startMs >= endMs) continue;
    if (range.startMs > cursor)
      gaps.push({ startMs: cursor, endMs: range.startMs });
    cursor = Math.max(cursor, range.endMs);
  }
  if (cursor < endMs) gaps.push({ startMs: cursor, endMs });
  return gaps;
}

/** A pending tool waits here, not in repeated model rounds. Every read sees committed chunks. */
export async function readTranscriptTool(
  initial: Analysis,
  reader: TranscriptReader | undefined,
  query: { atMs: number } | { query: string },
  heardUntilMs: number,
  signal?: AbortSignal,
  waitMs = 20000,
  current: () => boolean = () => true,
) {
  const check = () => {
    signal?.throwIfAborted();
    if (!current()) throw new DOMException("Question superseded", "AbortError");
  };
  check();
  const at =
    "atMs" in query ? Math.min(query.atMs, heardUntilMs) : heardUntilMs;
  const start = "atMs" in query ? Math.max(0, at - 30000) : 0;
  const end =
    "atMs" in query ? Math.min(heardUntilMs, at + 15000) : heardUntilMs;
  let analysis = reader ? await reader.read() : initial;
  let gaps = missingRanges(analysis, start, end);
  const deadline = Date.now() + waitMs;
  if (reader && gaps.length && analysis.transcript?.state === "processing") {
    await reader.prioritize(at);
    while (
      gaps.length &&
      analysis.transcript?.state === "processing" &&
      Date.now() < deadline
    ) {
      check();
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(signal?.reason);
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        }, 250);
        signal?.addEventListener("abort", abort, { once: true });
      });
      check();
      analysis = await reader.read();
      gaps = missingRanges(analysis, start, end);
    }
  }
  check();
  const passages =
    "atMs" in query
      ? getPassage(analysis, at, heardUntilMs)
      : searchPodcast(analysis, query.query, heardUntilMs);
  return {
    passages,
    value: analysis.transcript
      ? {
          passages,
          missingRanges: gaps,
          status: gaps.length ? analysis.transcript.state : "complete",
          note: gaps.length
            ? "Some requested audio is not transcribed yet. Missing text is not evidence of absence. Do not invent what was said or claim the whole episode was searched. Explain the missing context if needed; do not repeatedly poll this tool."
            : "Requested audio coverage is complete.",
        }
      : passages,
  };
}
