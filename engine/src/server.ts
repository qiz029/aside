import {
  selectVoice,
  type Analysis,
  type Passage,
  type Turn,
  type Speaker,
} from "./core.js";
export interface AnalysisPort {
  transcribe(audio: Uint8Array, offsetMs: number): Promise<Passage[]>;
  enrich(
    audio: Uint8Array,
    passages: Passage[],
    persistEvidence: (value: string) => Promise<void>,
  ): Promise<{
    summary: string;
    hostStyle: string;
    speakers: Speaker[];
    groups: { firstId: string; lastId: string }[];
  }>;
}
export function makeAnalysis(
  passages: Passage[],
  info: Awaited<ReturnType<AnalysisPort["enrich"]>>,
): Analysis {
  const sorted = [...passages].sort((a, b) => a.startMs - b.startMs);
  const covered = new Set<string>();
  const anchors = info.groups.flatMap((g, i) => {
    const start = sorted.findIndex((p) => p.id === g.firstId),
      end = sorted.findIndex((p) => p.id === g.lastId);
    if (
      start < 0 ||
      end < start ||
      sorted.slice(start, end + 1).some((p) => covered.has(p.id))
    )
      return [];
    const ps = sorted.slice(start, end + 1);
    ps.forEach((p) => covered.add(p.id));
    return [
      {
        id: `a-${i}`,
        startMs: Math.max(0, ps[0].startMs - 100),
        endMs: ps.at(-1)!.endMs,
        text: ps.map((p) => p.text).join(""),
        confidence: 0.75,
      },
    ];
  });
  for (const p of sorted)
    if (!covered.has(p.id))
      anchors.push({
        id: `a-${p.id}`,
        startMs: Math.max(0, p.startMs - 100),
        endMs: p.endMs,
        text: p.text,
        confidence: 0.5,
      });
  const picked = selectVoice(info.speakers);
  return {
    version: crypto.randomUUID(),
    passages: sorted,
    anchors: anchors.sort((a, b) => a.startMs - b.startMs),
    ...info,
    voice: picked.voice,
    voiceReason: picked.reason,
    source: "provider",
  };
}
/**
 * The model sees a passage's declared fields only. Stored passages may carry
 * word timings and other bulk that the transcript UI wants but a prompt must
 * not pay for: with them, two minutes of a long recording already exceeded
 * the trial request limit and every question failed.
 */
export const modelPassage = ({
  id,
  startMs,
  endMs,
  text,
  speaker,
}: Passage): Passage => ({ id, startMs, endMs, text, speaker });
export function getPassage(a: Analysis, atMs: number, heardUntilMs: number) {
  return a.passages
    .filter((p) => p.endMs >= atMs - 30000 && p.startMs <= atMs + 15000)
    .filter((p) => p.endMs <= heardUntilMs)
    .map(modelPassage);
}
const terms = (s: string) => {
  const t = s.toLowerCase();
  return [
    ...new Set([
      ...(t.match(/[a-z0-9]{2,}/g) ?? []),
      ...(t.match(/[\u3400-\u9fff]{2,}/g) ?? []).flatMap((w) =>
        Array.from({ length: w.length - 1 }, (_, i) => w.slice(i, i + 2)),
      ),
    ]),
  ];
};
export function searchPodcast(
  a: Analysis,
  query: string,
  heardUntilMs: number,
) {
  const ts = terms(query);
  return a.passages
    .filter((p) => p.endMs <= heardUntilMs)
    .map((p) => ({
      ...modelPassage(p),
      score: ts.reduce(
        (n, t) => n + (p.text.toLowerCase().includes(t) ? 1 : 0),
        0,
      ),
    }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
}
/** Upper bound on the serialized context; the provider rejects trial requests above 32000 bytes. */
export const CONTEXT_BYTES = 24000;
export function buildContext(
  a: Analysis,
  atMs: number,
  history: Turn[],
  maxBytes = CONTEXT_BYTES,
) {
  const current = a.passages.find((p) => p.startMs <= atMs && p.endMs > atMs);
  const context = {
    playheadMs: atMs,
    currentPassage: current
      ? { ...modelPassage(current), partiallyHeard: true }
      : null,
    recentTranscript: a.passages
      .filter((p) => p.startMs >= atMs - 120000 && p.endMs <= atMs)
      .map(modelPassage),
    earlierExcerpts: a.passages
      .filter((p) => p.endMs <= atMs - 120000)
      .filter((_, i, all) => i % Math.max(1, Math.ceil(all.length / 12)) === 0)
      .slice(-12)
      .map(modelPassage),
    hostStyle: a.hostStyle,
    history: history.slice(-20),
  };
  // Shed the least valuable material first: old turns, then early excerpts,
  // then the oldest recent transcript. The current passage always stays.
  const size = () => new TextEncoder().encode(JSON.stringify(context)).length;
  while (size() > maxBytes) {
    if (context.history.length > 4) context.history = context.history.slice(1);
    else if (context.earlierExcerpts.length)
      context.earlierExcerpts = context.earlierExcerpts.slice(1);
    else if (context.recentTranscript.length)
      context.recentTranscript = context.recentTranscript.slice(1);
    // Four turns are a preference, not a reason to reject a continuing chat.
    // Long old answers can be dropped while the newest question stays intact.
    else if (context.history.length > 1)
      context.history = context.history.slice(1);
    else break;
  }
  return context;
}

/** Byte budget is a conservative upper bound on tokenizer tokens for startup history. */
export function liveStartupHistory(history: Turn[], maxBytes = 6000): Turn[] {
  const encoder = new TextEncoder();
  let budget = maxBytes;
  const selected: Turn[] = [];
  for (const turn of history.slice(-12).reverse()) {
    let text = "";
    for (const char of turn.text) {
      const bytes = encoder.encode(char).length;
      if (bytes > budget) break;
      text += char;
      budget -= bytes;
    }
    if (text) selected.unshift({ role: turn.role, text });
    if (budget < 4) break;
  }
  return selected;
}
