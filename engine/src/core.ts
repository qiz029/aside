export { normalizeSpokenText, matchesSpokenText } from "./spoken-text.js";
export type Voice = "masculine" | "feminine" | "unknown";
export const MAX_AUDIO_DURATION_MS = 5 * 60 * 60 * 1000;
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
/** Segment granularity only: nothing presents or seeks below sentence level. */
export interface Passage {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  speaker: string;
}
export interface Anchor {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number;
}
export interface Speaker {
  id: string;
  presentation: Voice;
  durationMs: number;
  confidence: number;
}
export interface Analysis {
  version: string;
  passages: Passage[];
  anchors: Anchor[];
  speakers: Speaker[];
  summary: string;
  hostStyle: string;
  voice: "masculine" | "feminine";
  voiceReason: string;
  source: "provider" | "demo" | "synthesis";
}
export interface Episode {
  attribution?: {
    publisher: string;
    author: string;
    sourceUrl: string;
    licenseUrl: string;
    license: string;
    language: string;
    /** Interface languages this recording is published on; absent means all. */
    languageVisibility?: string[];
    excerptStartMs: number;
    excerptEndMs: number;
  };
  mimeType?: string;
  /** Artwork embedded in the uploaded file, served at `/api/episodes/:id/cover`. */
  cover?: boolean;
  id: string;
  title: string;
  createdAt: string;
  durationMs: number;
  status: "queued" | "analyzing" | "ready" | "failed" | "blocked";
  stage: string;
  progress: number;
  error?: string;
  analysis?: Analysis;
}
export type { Turn } from "./contracts.js";
export function selectVoice(speakers: Speaker[]): {
  voice: "masculine" | "feminine";
  reason: string;
} {
  const totals = { masculine: 0, feminine: 0 };
  for (const s of speakers)
    if (s.presentation !== "unknown" && s.confidence >= 0.6)
      totals[s.presentation] += s.durationMs;
  if (totals.masculine !== totals.feminine)
    return {
      voice: totals.masculine > totals.feminine ? "masculine" : "feminine",
      reason: "按可识别说话时长自动选择",
    };
  const lead = [...speakers].sort((a, b) => b.durationMs - a.durationMs)[0];
  return {
    voice: lead?.presentation === "feminine" ? "feminine" : "masculine",
    reason:
      lead?.presentation !== "unknown" && lead
        ? "跟随主讲人声音倾向"
        : "声音倾向不明确，使用默认声音",
  };
}
export function resumeAnchor(
  anchors: Anchor[],
  positionMs: number,
): Anchor | undefined {
  const before = anchors
    .filter((a) => a.startMs <= positionMs)
    .sort((a, b) => b.startMs - a.startMs);
  return before.find((a) => positionMs < a.endMs) ?? before[0] ?? anchors[0];
}
export type Mode =
  | "paused"
  | "playing"
  | "listening"
  | "answering"
  | "awaiting_followup"
  | "resuming"
  | "reconnecting";
export interface PlaybackState {
  mode: Mode;
  positionMs: number;
  revision: number;
  interruption?: { atMs: number; resumeMs: number; anchorId?: string };
  userSpeaking: boolean;
  assistantSpeaking: boolean;
  resumeRequested: boolean;
}
export const initialPlayback = (positionMs = 0): PlaybackState => ({
  mode: "paused",
  positionMs,
  revision: 0,
  userSpeaking: false,
  assistantSpeaking: false,
  resumeRequested: false,
});
export type PlaybackEvent =
  | { type: "play" }
  | { type: "pause" }
  | { type: "tick"; atMs: number }
  | { type: "seek"; atMs: number }
  | { type: "interrupt"; atMs: number; anchor?: Anchor }
  | { type: "user_end" }
  | { type: "assistant_start"; revision: number }
  | { type: "assistant_end"; revision: number }
  | { type: "resume" }
  | { type: "resumed"; revision: number }
  | { type: "disconnect" };
export function transition(s: PlaybackState, e: PlaybackEvent): PlaybackState {
  switch (e.type) {
    case "tick":
      return { ...s, positionMs: e.atMs };
    case "play":
      return s.interruption
        ? transition(s, { type: "resume" })
        : { ...s, mode: "playing" };
    case "pause":
      return {
        ...s,
        mode: "paused",
        resumeRequested: false,
        revision: s.revision + 1,
      };
    case "seek":
      return { ...initialPlayback(e.atMs), revision: s.revision + 1 };
    case "interrupt":
      return {
        ...s,
        mode: "listening",
        positionMs: e.atMs,
        revision: s.revision + 1,
        userSpeaking: true,
        assistantSpeaking: false,
        resumeRequested: false,
        interruption: s.interruption ?? {
          atMs: e.atMs,
          resumeMs: e.anchor?.startMs ?? e.atMs,
          anchorId: e.anchor?.id,
        },
      };
    case "user_end":
      return { ...s, userSpeaking: false };
    case "assistant_start":
      return e.revision !== s.revision || !s.interruption
        ? s
        : { ...s, mode: "answering", assistantSpeaking: true };
    case "assistant_end":
      return e.revision !== s.revision
        ? s
        : {
            ...s,
            assistantSpeaking: false,
            mode:
              s.resumeRequested && !s.userSpeaking
                ? "resuming"
                : s.interruption
                  ? "awaiting_followup"
                  : s.mode,
          };
    case "resume":
      return {
        ...s,
        resumeRequested: true,
        mode: !s.userSpeaking && !s.assistantSpeaking ? "resuming" : s.mode,
      };
    case "resumed":
      return e.revision !== s.revision ||
        s.mode !== "resuming" ||
        s.userSpeaking ||
        s.assistantSpeaking
        ? s
        : {
            ...initialPlayback(s.interruption?.resumeMs ?? s.positionMs),
            mode: "playing",
            revision: s.revision + 1,
          };
    case "disconnect":
      return {
        ...s,
        mode: "reconnecting",
        revision: s.revision + 1,
        userSpeaking: false,
        assistantSpeaking: false,
        resumeRequested: false,
      };
  }
}
/** High-confidence commands only. Ambiguous requests go to the conversational backend. */
export function explicitResume(text: string): boolean {
  const value = text
    .trim()
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[，。！!.,?？]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const english =
    /^(?:(?:ok|okay|alright|thanks|thank you|that's all|no more questions) )?(?:please )?(?:continue|go on|resume(?: playback| the podcast)?|continue (?:playing|the podcast)|(?:play|resume) (?:the )?(?:podcast|episode)|(?:let's |can we |could we )?(?:get |go )?back to (?:the )?(?:podcast|episode)|(?:can you |could you |would you )?(?:resume|continue) (?:the )?(?:podcast|playback)|no more questions)(?: please)?$/;
  const chinese =
    /^(?:(?:好|好的|好吧|行|可以|谢谢|没问题了|没有其他问题了)\s*)?(?:请\s*)?(?:继续(?:播放|听|吧|播客|节目)?|接着(?:播放|听|播)|(?:回到|返回)(?:播客|节目)|(?:播放|继续播放)(?:播客|节目)|没有(?:其他)?问题了|没问题了)(?:吧|就好)?$/;
  return english.test(value) || chinese.test(value);
}

export interface MicrophoneConfig {
  /** Client recording cap; paid endpoints independently validate audio length. */
  maxCaptureMs?: number;
  vadEnabled?: boolean;
  vadThreshold?: number;
  vadMinRms?: number;
  /** Linear RMS amplitude, not decibels. */
  threshold: number;
  minSpeechMs: number;
  silenceMs: number;
}

export interface VoiceLifecycleConfig {
  preRollMs: number;
  graceMs: number;
  idleCloseMs: number;
  autoResumeMs?: number;
}
