import type { AnalysisPort } from "@aside/engine/server";
import type { Passage } from "@aside/engine/core";
import { AudioProvider } from "./audio-provider.js";
import { attachLiveSideband } from "./live-sideband.js";
/** Model adapter accepts bytes; persistence belongs to the repository. */
export class OpenAIProvider extends AudioProvider implements AnalysisPort {
  attachLive(
    sessionId: string,
    receive: (event: Record<string, unknown>) => void,
    closed: () => void,
  ) {
    return attachLiveSideband(this.client.apiKey!, sessionId, receive, closed);
  }
  constructor(
    key: string,
    model = process.env.ASIDE_BACKEND_MODEL || "gpt-5.6-luna",
  ) {
    super(key, model);
  }
  async transcribe(audio: Uint8Array, offsetMs: number) {
    return this.transcribeAudio(audio, offsetMs);
  }
  async enrich(
    audio: Uint8Array,
    passages: Passage[],
    persistEvidence: (value: string) => Promise<void>,
  ) {
    return this.enrichAudio(audio, passages, persistEvidence);
  }
}
