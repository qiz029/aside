import type {
  MicrophoneConfig,
  VoiceLifecycleConfig,
} from "@aside/engine/core";
import { LocalMicrophone, type MicrophonePort } from "./microphone";
import { LiveConnection, type LiveCallbacks } from "./live";
export type VoiceStatus =
  "off" | "arming" | "armed" | "connecting" | "transcribing" | "on" | "closing";
export interface CloudPort {
  connect(
    source: MediaStream,
    create: (
      sdp: string,
    ) => Promise<{ session: { id: string }; transport: { sdp: string } }>,
  ): Promise<void>;
  append(
    type: "thinking" | "commentary" | "instructions",
    content: string,
    id?: string | null,
  ): void;
  mute(value: boolean): void;
  prepareOutput?(): void;
  discardPendingOutput?(): void;
  input(value: boolean): void;
  interrupt(): void;
  close(): Promise<void>;
  levels?(levels: Float32Array): boolean;
  diagnostics?(): Promise<unknown>;
}
export interface VoiceCallbacks extends Omit<
  LiveCallbacks,
  "onClose" | "onUsage"
> {
  onSpeech(active: boolean): void;
  onUsage?(seconds: number, sessionId: string): void;
  onStatus(status: VoiceStatus): void;
  onFirstQuestion(text: string): void;
  onClose(
    finalized: boolean,
    seconds: number,
    sessionId: string,
    intentional: boolean,
  ): void;
}
export interface VoiceDependencies {
  microphone: (
    speech: (active: boolean) => void,
    error: (message: string) => void,
  ) => MicrophonePort;
  cloud: (callbacks: LiveCallbacks) => CloudPort;
  create: (
    sdp: string,
  ) => Promise<{ session: { id: string }; transport: { sdp: string } }>;
  transcribe: (audio: Blob, signal: AbortSignal) => Promise<string>;
}
/** Owns cloud lifecycle, separately from the durable podcast playback state. */
export class OnDemandVoice {
  private mic: MicrophonePort;
  private cloud?: CloudPort;
  private enabled = false;
  private microphoneReady = false;
  private version = 0;
  private questionVersion = 0;
  private speaking = false;
  private cold = false;
  private connecting?: Promise<void>;
  private closing: Promise<void> = Promise.resolve();
  private recognition?: AbortController;
  private graceTimer?: ReturnType<typeof setTimeout>;
  private coldTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private status: VoiceStatus = "off";
  private desiredMuted = true;
  private working = false;
  private outputActive = false;
  private suppressUntilSpeechEnd = false;
  constructor(
    private config: VoiceLifecycleConfig,
    private cb: VoiceCallbacks,
    private deps: VoiceDependencies,
    private manual = false,
    private continuous = false,
  ) {
    this.mic = deps.microphone(
      (a) => {
        if (!this.manual) this.speech(a);
      },
      (e) => this.fail(e),
    );
  }
  get isCold() {
    return this.cold;
  }
  get isEnabled() {
    return this.enabled;
  }
  async diagnostics() {
    return {
      status: this.status,
      enabled: this.enabled,
      microphoneReady: this.microphoneReady,
      cold: this.cold,
      speaking: this.speaking,
      suppressUntilSpeechEnd: this.suppressUntilSpeechEnd,
      microphone: this.mic.diagnostics?.(),
      live: await this.cloud?.diagnostics?.(),
    };
  }
  private setStatus(status: VoiceStatus) {
    this.status = status;
    this.cb.onStatus(status);
  }
  async enable() {
    if (this.enabled) return;
    this.enabled = true;
    const version = this.version;
    this.setStatus("arming");
    try {
      await this.mic.start();
      if (!this.enabled || this.version !== version) {
        this.mic.stop();
        return;
      }
      this.microphoneReady = true;
      this.setStatus("armed");
      if (this.continuous && !this.manual)
        void this.ensureCloud().catch(() => {});
    } catch (error) {
      this.fail((error as Error).message);
    }
  }
  /** Manual capture always uses local WAV transcription, including warm follow-ups. */
  beginManual() {
    if (!this.manual || !this.enabled || !this.microphoneReady || this.speaking)
      return false;
    this.cold = true;
    this.cloud?.input(false);
    this.mic.discard();
    this.speech(true);
    return true;
  }
  endManual() {
    if (this.manual && this.speaking) this.speech(false);
  }
  get isWarm() {
    return !!this.cloud && !this.connecting;
  }
  private clearTimers() {
    clearTimeout(this.graceTimer);
    clearTimeout(this.idleTimer);
  }
  private speech(active: boolean) {
    if (!this.enabled) return;
    this.speaking = active;
    if (this.suppressUntilSpeechEnd) {
      if (!active) {
        this.suppressUntilSpeechEnd = false;
        this.cloud?.input(!this.manual);
      }
      return;
    }
    this.clearTimers();
    if (active) {
      // Continuous listening keeps one session open, so a capture that began
      // before it connected is only waiting for its transcription. On
      // loudspeakers the podcast keeps re-triggering the detector; restarting
      // the capture each time would leave the microphone detached for good.
      if (this.settlingCold) {
        if (!this.recognition) this.leaveCold();
        this.cb.onSpeech(true);
        return;
      }
      this.questionVersion++;
      this.recognition?.abort();
      if (!this.cloud || this.connecting || this.cold) {
        this.cold = true;
        this.mic.begin();
        this.cb.onSpeech(true);
        void this.ensureCloud().catch(() => {});
      } else this.cb.onSpeech(true);
    } else {
      this.cb.onSpeech(false);
      if (this.cold) {
        if (!(this.settlingCold && this.recognition))
          void this.finishFirstQuestion();
      } else this.activity();
    }
  }
  /** A pre-connection capture that outlived the connection it was covering for. */
  private get settlingCold() {
    return (
      this.continuous &&
      !this.manual &&
      this.cold &&
      !!this.cloud &&
      !this.connecting
    );
  }
  /** Hands the microphone to the open session; whatever was captured locally is dropped. */
  private leaveCold() {
    clearTimeout(this.coldTimer);
    this.mic.discard();
    this.cold = false;
    this.setStatus("on");
    this.cloud?.input(!this.manual);
    this.cloud?.mute(this.desiredMuted);
    this.activity();
  }
  private ensureCloud(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.cloud) return Promise.resolve();
    const version = this.version;
    const work = (async () => {
      await this.closing;
      if (!this.enabled || version !== this.version) return;
      this.setStatus("connecting");
      let sessionId = "";
      let intentional = false;
      const cloud = this.deps.cloud({
        onInputTranscript: (text) => {
          if (this.cloud === cloud && version === this.version)
            this.cb.onInputTranscript?.(text);
        },
        onDiagnostic: (message) => {
          if (this.cloud === cloud) this.cb.onDiagnostic?.(message);
        },
        onUsage: (seconds) => this.cb.onUsage?.(seconds, sessionId),
        onReady: () => {
          if (this.cloud !== cloud || version !== this.version) return;
          cloud.mute(true);
          this.cb.onReady();
        },
        onOutput: (active) => {
          if (this.cloud !== cloud || version !== this.version || this.cold)
            return;
          this.outputActive = active;
          this.activity();
          this.cb.onOutput(active);
        },
        onTranscript: (role, text, timing) => {
          if (this.cloud !== cloud || version !== this.version || this.cold)
            return;
          this.activity();
          this.cb.onTranscript(role, text, timing);
        },
        onDelegation: (id) => {
          if (this.cloud !== cloud || version !== this.version || this.cold)
            return;
          this.activity();
          this.cb.onDelegation(id);
        },
        onError: (message) => {
          if (this.cloud === cloud) this.cb.onError(message);
        },
        onClose: (finalized, seconds) => {
          const wasCurrent = this.cloud === cloud;
          intentional = !wasCurrent || !this.enabled;
          this.cb.onClose(finalized, seconds, sessionId, intentional);
          if (wasCurrent) {
            this.cloud = undefined;
            if (this.enabled) {
              this.cold = false;
              this.recognition?.abort();
              this.mic.discard();
              this.clearTimers();
              this.setStatus("armed");
            }
          }
        },
      });
      this.cloud = cloud;
      await cloud.connect(this.mic.stream, async (sdp) => {
        const result = await this.deps.create(sdp);
        sessionId = result.session.id;
        return result;
      });
      if (!this.enabled || version !== this.version || this.cloud !== cloud) {
        await cloud.close();
        return;
      }
      if (!this.cold)
        this.cloud?.input(!this.manual && !this.suppressUntilSpeechEnd);
      // Speech that never audibly ends (podcast bleed) must not keep the
      // session deaf: the local capture gets a bounded head start.
      else if (this.continuous && !this.manual) {
        clearTimeout(this.coldTimer);
        this.coldTimer = setTimeout(() => {
          if (version === this.version && this.cold && !this.recognition)
            this.leaveCold();
        }, 4000);
      }
      this.setStatus(this.cold ? "transcribing" : "on");
    })();
    this.connecting = work;
    void work
      .catch((error) => {
        if (version === this.version && this.enabled) {
          this.cb.onError((error as Error).message);
          this.endCloud();
        }
      })
      .finally(() => {
        if (this.connecting === work) this.connecting = undefined;
      });
    return work;
  }
  private async finishFirstQuestion() {
    const version = this.version,
      revision = this.questionVersion;
    const abort = new AbortController();
    this.recognition?.abort();
    this.recognition = abort;
    this.setStatus("transcribing");
    try {
      const audio = this.mic.snapshot();
      if (this.manual) this.mic.discard();
      const text = await this.deps.transcribe(audio, abort.signal);
      await this.ensureCloud();
      if (
        abort.signal.aborted ||
        !this.enabled ||
        version !== this.version ||
        !this.cloud
      )
        return;
      // An on-demand session waits for the listener to finish. A continuous
      // one is already listening, so the first transcription ends the local
      // phase whatever the detector reports since.
      if (
        !this.continuous &&
        (revision !== this.questionVersion || this.speaking)
      )
        return;
      if (!text.trim()) {
        if (!this.continuous) throw Error("没有识别到完整问题，请再说一次");
        // Noise before the connection is not a failed question.
        this.leaveCold();
        return;
      }
      clearTimeout(this.coldTimer);
      this.mic.discard();
      this.cold = false;
      this.setStatus("on");
      this.cloud.append(
        "thinking",
        `Latest actual user utterance (transcribed user data): ${text}`,
      );
      this.cloud.append(
        "instructions",
        "The backend is handling the first question. Wait for its answer; do not delegate it again. Reply in the language of the actual user utterance, ignoring the language of metadata and prior assistant replies. Preserve the language of the backend answer. Handle subsequent live follow-ups normally.",
      );
      this.cloud.input(!this.manual);
      this.cloud.mute(this.desiredMuted);
      this.activity();
      this.cb.onFirstQuestion(text.trim());
    } catch (error) {
      if (
        !abort.signal.aborted &&
        version === this.version &&
        this.enabled &&
        revision === this.questionVersion
      ) {
        this.cb.onError((error as Error).message);
        // One failed transcription is no reason to drop a healthy open session.
        if (this.continuous && !this.manual && this.cloud) this.leaveCold();
        else this.endCloud();
      }
    } finally {
      if (this.recognition === abort) this.recognition = undefined;
    }
  }
  setWorking(value: boolean) {
    this.working = value;
    this.activity();
  }
  activity() {
    clearTimeout(this.idleTimer);
    if (this.continuous && !this.manual) return;
    if (
      this.cloud &&
      !this.cold &&
      !this.speaking &&
      !this.working &&
      !this.outputActive
    )
      this.idleTimer = setTimeout(() => {
        this.endCloud();
      }, this.config.idleCloseMs);
  }
  cancelCapture() {
    if (this.manual) this.speaking = false;
    this.questionVersion++;
    this.recognition?.abort();
    this.mic.discard();
    if (this.cold) {
      this.suppressUntilSpeechEnd = !this.manual && this.speaking;
      this.cold = false;
      this.cloud?.input(!this.manual && !this.suppressUntilSpeechEnd);
    }
  }
  playbackResumed() {
    this.cancelCapture();
    this.cold = false;
    this.questionVersion++;
    this.recognition?.abort();
    this.mic.discard();
    this.mute(true);
    this.clearTimers();
    if (!this.continuous && (this.cloud || this.connecting))
      this.graceTimer = setTimeout(() => this.endCloud(), this.config.graceMs);
  }
  private endCloud() {
    this.clearTimers();
    clearTimeout(this.coldTimer);
    this.questionVersion++;
    this.recognition?.abort();
    this.mic.discard();
    this.cold = false;
    this.outputActive = false;
    const cloud = this.cloud;
    this.cloud = undefined;
    this.connecting = undefined;
    this.version++;
    if (cloud) {
      this.setStatus("closing");
      const close = cloud.close();
      this.closing = close;
      void close.finally(() => {
        if (this.enabled && !this.cloud && !this.connecting)
          this.setStatus("armed");
      });
    } else if (this.enabled) this.setStatus("armed");
  }
  append(
    type: "thinking" | "commentary" | "instructions",
    content: string,
    id: string | null = null,
  ) {
    this.cloud?.append(type, content, id);
  }
  mute(value: boolean) {
    this.desiredMuted = value;
    this.cloud?.mute(value || this.cold);
  }
  prepareOutput() {
    this.cloud?.prepareOutput?.();
  }
  discardPendingOutput() {
    this.cloud?.discardPendingOutput?.();
  }
  interrupt() {
    this.outputActive = false;
    this.clearTimers();
    this.cloud?.interrupt();
  }
  outputLevels(levels: Float32Array) {
    return this.cloud?.levels?.(levels) ?? false;
  }
  inputLevel() {
    return this.enabled && this.microphoneReady
      ? (this.mic.inputLevel?.() ?? 0)
      : 0;
  }
  async close() {
    this.enabled = false;
    this.microphoneReady = false;
    this.endCloud();
    this.mic.stop();
    this.setStatus("off");
    await this.closing;
  }
  private fail(message: string) {
    this.cb.onError(message);
    void this.close();
  }
}
export function createOnDemandVoice(
  microphone: MicrophoneConfig,
  config: VoiceLifecycleConfig,
  cb: VoiceCallbacks,
  remote: Pick<VoiceDependencies, "create" | "transcribe">,
  manual = false,
) {
  return new OnDemandVoice(
    config,
    cb,
    {
      ...remote,
      microphone: (speech, error) =>
        new LocalMicrophone(
          manual ? { ...microphone, vadEnabled: false } : microphone,
          manual ? 0 : Math.max(config.preRollMs, microphone.minSpeechMs + 80),
          speech,
          error,
        ),
      cloud: (callbacks) => new LiveConnection(callbacks),
    },
    manual,
    !manual,
  );
}
