import type { Analysis, Turn } from "@aside/engine/core";
import type { LiveResult, LivePlayerState } from "@aside/engine/contracts";
import type { AnalysisPort } from "@aside/engine/server";
import type { QuestionAnswerer } from "./question-service.js";
import type { LiveSideband } from "./live-sideband.js";
export interface VoiceProvider {
  attachLive?(
    sessionId: string,
    receive: (event: Record<string, unknown>) => void,
    closed: () => void,
  ): Promise<LiveSideband>;
  transcribeQuestion(audio: Buffer, signal?: AbortSignal): Promise<string>;
  createLive(
    sdp: string,
    analysis: Analysis,
    atMs: number,
    history?: Turn[],
    /** Present under server voice control: the session delegates to the question model. */
    control?: { trial: boolean; player?: LivePlayerState },
  ): Promise<LiveResult>;
}
export interface BackendServices {
  analysis: AnalysisPort;
  questions: QuestionAnswerer;
  voice: VoiceProvider;
}
