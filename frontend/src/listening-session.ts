import {
  ListeningSession as SharedSession,
  type SessionOptions,
} from "@aside/player-runtime/listening-session";
import { createOnDemandVoice } from "./on-demand-voice";
import type { PodcastAudio } from "./podcast-audio";
import type { PlayerBackend } from "./player-api";
export type {
  ListeningMode,
  VoicePort,
} from "@aside/player-runtime/listening-session";
export class ListeningSession extends SharedSession {
  constructor(
    audio: PodcastAudio,
    backend: PlayerBackend,
    options: Partial<SessionOptions> = {},
  ) {
    super(
      audio,
      {
        ...backend,
        transcribe: (id, data, signal) =>
          backend.transcribe(id, data as Blob, signal),
      },
      {
        ...options,
        voiceFactory:
          options.voiceFactory ??
          ((mic, config, cb, remote, manual) =>
            createOnDemandVoice(
              mic,
              config,
              cb,
              {
                ...remote,
                transcribe: (audio, signal) => remote.transcribe(audio, signal),
              },
              manual,
            )),
      },
    );
  }
}
