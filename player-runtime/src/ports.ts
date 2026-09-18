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
  LiveControlEvent,
  LiveControlUpdate,
  TranscriptTiming,
} from "@aside/engine/contracts";
import type { PlayerConfig } from "@aside/engine/player";
export interface PodcastAudio {
  positionMs: number;
  play(): Promise<void>;
  pause(): void;
  configure(config: PlayerConfig): void;
  seek?(atMs: number): Promise<void>;
  /**
   * Reversible attention cue: scale the podcast toward `level` (a fraction of
   * the configured volume) over `durationMs`. Ignored while settling.
   */
  duck(level: number, durationMs: number): void;
  /** Fade to silence over `durationMs`, then pause. A newer play, pause or settle supersedes it. */
  settle(durationMs: number): Promise<void>;
}
export interface PlayerBackend {
  question(
    id: string,
    request: QuestionRequest,
    signal: AbortSignal,
    progress: (phase: QuestionPhase) => void,
    onAnswer?: (text: string) => void,
  ): Promise<QuestionResult>;
  live(id: string, request: LiveRequest): Promise<LiveResult>;
  control?(
    id: string,
    sessionId: string,
    signal: AbortSignal,
    receive: (event: LiveControlEvent) => void,
  ): Promise<void>;
  updateControl?(
    id: string,
    update: LiveControlUpdate,
    signal: AbortSignal,
  ): Promise<void>;
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
  onInputTranscript?(text: string): void;
  onDiagnostic?(message: string): void;
  onReady(): void;
  onOutput(active: boolean): void;
  onTranscript(
    role: Turn["role"],
    text: string,
    timing?: TranscriptTiming,
  ): void;
  onDelegation(id: string): void;
  onError(message: string): void;
  onSpeech(active: boolean): void;
  /** Submitted manual ASR text; may arrive before the answer connection is ready. */
  onQuestionRecognized?(text: string): void;
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
  /** Browser PCM gate: keep pending reply audio until the backend admits it. */
  prepareOutput?(): void;
  discardPendingOutput?(): void;
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
  /** Current local microphone amplitude; reading this never starts capture. */
  inputLevel?(): number;
  diagnostics?(): Promise<unknown>;
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
