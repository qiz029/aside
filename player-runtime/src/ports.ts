import type {
  MicrophoneConfig,
  VoiceLifecycleConfig,
  Turn,
} from "@aside/engine/core";
import type {
  LiveRequest,
  LiveResult,
  QuestionRequest,
  QuestionResult,
  QuestionPhase,
} from "@aside/engine/contracts";
import type { PlayerConfig } from "@aside/engine/player";
export interface PodcastAudio {
  positionMs: number;
  play(): Promise<void>;
  pause(): void;
  configure(config: PlayerConfig): void;
  seek?(atMs: number): Promise<void>;
}
export interface PlayerBackend {
  question(
    id: string,
    request: QuestionRequest,
    signal: AbortSignal,
    progress: (phase: QuestionPhase) => void,
  ): Promise<QuestionResult>;
  live(id: string, request: LiveRequest): Promise<LiveResult>;
  transcribe(id: string, audio: unknown, signal: AbortSignal): Promise<string>;
  usage(
    id: string,
    data: {
      sessionId: string;
      seconds: number;
      finalized: boolean;
      closed?: boolean;
    },
  ): Promise<void>;
}
export interface PlayerHealth {
  liveConfigured: boolean;
  microphone: MicrophoneConfig;
  voiceLifecycle: VoiceLifecycleConfig;
}
export type VoiceStatus =
  "off" | "arming" | "armed" | "connecting" | "transcribing" | "on" | "closing";
export interface VoiceCallbacks {
  onReady(): void;
  onOutput(active: boolean): void;
  onTranscript(role: Turn["role"], text: string): void;
  onDelegation(id: string): void;
  onError(message: string): void;
  onSpeech(active: boolean): void;
  onFirstQuestion(text: string): void;
  onStatus(status: VoiceStatus): void;
  onUsage?(seconds: number, sessionId: string): void;
  onClose(
    finalized: boolean,
    seconds: number,
    sessionId: string,
    intentional: boolean,
  ): void;
}
export interface VoicePort {
  readonly isEnabled: boolean;
  readonly isWarm: boolean;
  readonly isCold: boolean;
  enable(): Promise<void>;
  beginManual(): boolean;
  endManual(): void;
  close(): Promise<void>;
  cancelCapture(): void;
  mute(value: boolean): void;
  interrupt(): void;
  playbackResumed(): void;
  append(
    channel: "thinking" | "commentary" | "instructions",
    content: string,
    id?: string | null,
  ): void;
  activity(): void;
  setWorking(value: boolean): void;
  outputLevels?(levels: Float32Array): boolean;
}
export type VoiceFactory = (
  microphone: MicrophoneConfig,
  config: VoiceLifecycleConfig,
  callbacks: VoiceCallbacks,
  remote: {
    create(sdp: string): Promise<LiveResult>;
    transcribe(audio: unknown, signal: AbortSignal): Promise<string>;
  },
  manual?: boolean,
) => VoicePort;
