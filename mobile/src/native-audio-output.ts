import { NativeModules } from "react-native";
import type { TranscriptTiming } from "@aside/engine/contracts";
import type { MicrophoneConfig } from "@aside/engine/core";
import type { VoiceCallbacks } from "@aside/player-runtime/ports";

interface AudioStatus {
  generation: number;
  mode: number;
  active: boolean;
  drained: boolean;
  overflows: number;
  receivedFrames: number;
  playedThroughFrame: number;
  bufferedMs: number;
  inputLevel: number;
}
let generation = 0;
/** Native PCM owns pacing. JS only observes status, gates captions and reports VAD. */
export class NativeAudioOutput {
  private owner = Date.now() * 1000 + (++generation % 1000);
  private epoch = 0;
  private mode = 0;
  private timer?: ReturnType<typeof setInterval>;
  private active = false;
  private transcriptOpen = false;
  private drained = false;
  private closed = false;
  private speech = false;
  private speechCandidate?: number;
  private lastInput = 0;
  private status?: AudioStatus;
  private lastDrain?: AudioStatus;
  private pending: {
    text: string;
    frame: number;
    timing?: TranscriptTiming;
  }[] = [];
  private characters = 0;
  private operation = Promise.resolve();
  constructor(
    private cb: VoiceCallbacks,
    private microphone?: MicrophoneConfig,
  ) {}
  async start() {
    await NativeModules.AsideAudioSession.resetOutput(this.owner);
    if (this.closed) return;
    await this.command(this.mode);
    let polling = false;
    this.timer = setInterval(() => {
      if (polling || this.closed) return;
      polling = true;
      const epoch = this.epoch;
      void NativeModules.AsideAudioSession.audioStatus()
        .then((status: AudioStatus) => {
          if (
            this.closed ||
            epoch !== this.epoch ||
            status.generation !== this.owner
          )
            return;
          this.status = status;
          if (status.overflows)
            throw Error(
              "回答音频超出缓冲限制，请重新提问 / Voice reply exceeded the audio buffer. Please ask again.",
            );
          if (this.mode === 2 && status.active && !this.active) {
            this.active = true;
            this.drained = false;
            this.cb.onOutput(true);
            this.transcriptOpen = this.mode === 2;
          }
          this.flush();
          if (this.active && !status.active) {
            this.active = false;
            this.cb.onOutput(false);
          }
          if (
            this.mode === 2 &&
            this.transcriptOpen &&
            status.drained &&
            !this.drained &&
            !this.pending.length
          ) {
            this.drained = true;
            this.lastDrain = status;
            this.cb.onOutputDrained?.();
          }
          if (this.microphone) this.input(status.inputLevel);
        })
        .catch((error: unknown) => {
          if (!this.closed) {
            this.cb.onError(String(error));
            this.close();
          }
        })
        .finally(() => {
          polling = false;
        });
    }, 50);
  }
  private input(level: number) {
    const now = Date.now(),
      config = this.microphone!;
    if (level >= config.threshold) {
      this.lastInput = now;
      this.speechCandidate ??= now;
      if (!this.speech && now - this.speechCandidate >= config.minSpeechMs) {
        this.speech = true;
        this.cb.onSpeech(true);
      }
    } else {
      this.speechCandidate = undefined;
      if (this.speech && now - this.lastInput >= config.silenceMs) {
        this.speech = false;
        this.cb.onSpeech(false);
      }
    }
  }
  inputLevel() {
    return this.closed ? 0 : (this.status?.inputLevel ?? 0);
  }
  prepare() {
    if (this.mode === 0) void this.command(1);
  }
  discardPending() {
    if (this.mode === 1) void this.command(0);
  }
  mute(value: boolean) {
    void this.command(value ? 0 : 2);
  }
  private command(mode: number) {
    if (mode !== 0 && mode !== this.mode) this.lastDrain = undefined;
    this.mode = mode;
    if (mode === 0) {
      this.pending = [];
      this.characters = 0;
      this.transcriptOpen = this.active = this.drained = false;
    }
    const epoch = ++this.epoch;
    this.operation = this.operation
      .catch(() => {})
      .then(() =>
        NativeModules.AsideAudioSession.outputCommand(this.owner, epoch, mode),
      );
    void this.operation.catch((error: unknown) => {
      if (!this.closed) this.cb.onError(String(error));
    });
    return this.operation;
  }
  transcript(text: string, timing?: TranscriptTiming) {
    if (this.closed || this.mode === 0) return;
    if (this.characters + text.length > 32000) {
      this.cb.onError(
        "回答字幕超出限制，请重新提问 / Reply captions exceeded the buffer. Please ask again.",
      );
      this.close();
      return;
    }
    this.pending.push({
      text,
      timing,
      frame: this.status?.receivedFrames ?? 0,
    });
    this.characters += text.length;
    this.drained = false;
    this.flush();
  }
  private flush() {
    if (this.mode !== 2 || !this.transcriptOpen) return;
    while (
      this.pending.length &&
      this.pending[0].frame <= (this.status?.playedThroughFrame ?? 0)
    ) {
      const part = this.pending.shift()!;
      this.characters -= part.text.length;
      this.cb.onTranscript("assistant", part.text, part.timing);
    }
  }
  diagnostics() {
    return {
      ...this.status,
      lastDrain: this.lastDrain,
      pendingCaptionCharacters: this.characters,
    };
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    void this.command(0);
  }
}
