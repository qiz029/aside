import type { Turn } from "@aside/engine/core";
import type { TranscriptTiming } from "@aside/engine/contracts";
import { readSpeechLevels } from "./audio-levels";
import type {
  OutputBufferState,
  OutputCommand,
} from "./voice-output-worklet.js";
export interface LiveCallbacks {
  onReady(): void;
  onOutput(active: boolean): void;
  onTranscript(
    role: Turn["role"],
    text: string,
    timing?: TranscriptTiming,
  ): void;
  onDelegation(id: string): void;
  onError(message: string): void;
  onClose(finalized: boolean, seconds: number): void;
  onUsage?(seconds: number): void;
  onDiagnostic?(message: string): void;
  /** Raw recognition deltas for opt-in local diagnostics, before input gating. */
  onInputTranscript?(text: string): void;
}
export class LiveConnection {
  private peer?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private mic?: MediaStream;
  private ctx?: AudioContext;
  private output?: AnalyserNode;
  // Chromium needs an attached, playing media element to pull the remote track.
  // It is permanently silent; only the worklet connects to the audible output.
  private receiver = new Audio();
  private outputQueue?: AudioWorkletNode;
  private outputMode: "hold" | "play" | "discard" | "overflow" = "discard";
  private outputEpoch = 0;
  private outputBuffer?: OutputBufferState;
  private pendingTranscript: {
    text: string;
    frame: number;
    timing?: TranscriptTiming;
  }[] = [];
  private pendingTranscriptChars = 0;
  private transcriptOpen = false;
  private closeTimer?: number;
  private ready = false;
  private closing = false;
  private outputActive = false;
  private startTimer?: number;
  private resolveStart?: () => void;
  private rejectStart?: (error: Error) => void;
  private finished = false;
  private closedPromise?: Promise<void>;
  private resolveClose?: () => void;
  private seconds = 0;
  constructor(private callbacks: LiveCallbacks) {}
  async connect(
    source: MediaStream,
    create: (sdp: string) => Promise<{ transport: { sdp: string } }>,
  ) {
    try {
      this.mic = source.clone();
      this.mic.getTracks().forEach((t) => (t.enabled = false));
      const started = new Promise<void>((resolve, reject) => {
        this.resolveStart = resolve;
        this.rejectStart = reject;
      });
      // Mark rejection handled even if HTTP setup is still pending.
      void started.catch(() => {});
      this.startTimer = window.setTimeout(() => {
        this.rejectStart?.(Error("语音连接启动超时"));
        void this.close();
      }, 30000);
      this.ctx = new AudioContext();
      await this.ctx.resume();
      // The media track advances even when muted. Gate PCM before the speaker,
      // retaining the prefix while the NDJSON answer decision is in flight.
      await this.ctx.audioWorklet.addModule(
        new URL("./voice-output-worklet.js", import.meta.url).href,
      );
      this.outputQueue = new AudioWorkletNode(this.ctx, "aside-voice-output", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: "explicit",
      });
      this.outputQueue.onprocessorerror = () => {
        this.callbacks.onError(
          "Voice audio playback failed. Please reconnect the microphone.",
        );
        void this.close();
      };
      this.outputQueue.port.onmessage = ({ data }) => {
        if (this.closing || data.epoch !== this.outputEpoch) return;
        this.outputBuffer = data;
        if (data.mode === "overflow" && this.outputMode !== "overflow") {
          this.outputMode = "overflow";
          this.pendingTranscript = [];
          this.pendingTranscriptChars = 0;
          this.transcriptOpen = false;
          this.callbacks.onError(
            "Voice reply buffer exceeded 30 seconds. Please ask again.",
          );
        }
        if (data.active && !this.outputActive) {
          this.outputActive = true;
          this.callbacks.onOutput(true);
          this.transcriptOpen = this.outputMode === "play";
        }
        this.flushOutputTranscript();
        if (!data.active && this.outputActive) {
          this.outputActive = false;
          this.callbacks.onOutput(false);
        }
      };
      this.output = this.ctx.createAnalyser();
      this.output.fftSize = 1024;
      this.outputQueue.connect(this.output).connect(this.ctx.destination);
      this.setOutput(this.outputMode === "hold" ? "hold" : "discard");
      this.peer = new RTCPeerConnection();
      this.peer.ontrack = (e) => {
        const stream = e.streams[0] ?? new MediaStream([e.track]);
        this.receiver.muted = true;
        this.receiver.srcObject = stream;
        void this.receiver
          .play()
          .catch(() => this.callbacks.onError("请点击页面允许音频播放"));
        this.ctx!.createMediaStreamSource(stream).connect(this.outputQueue!);
      };
      for (const track of this.mic.getTracks())
        this.peer.addTrack(track, this.mic);
      this.channel = this.peer.createDataChannel("oai-events");
      this.channel.onmessage = (e) => {
        try {
          const m = JSON.parse(e.data);
          if (typeof m.type === "string" && m.type !== "session.usage.updated")
            this.callbacks.onDiagnostic?.(
              `Live event: ${m.type.slice(0, 100)}`,
            );
          if (m.type === "session.started") {
            this.ready = true;
            clearTimeout(this.startTimer);
            this.resolveStart?.();
            if (this.closing) {
              this.sendClose();
              return;
            }
            this.callbacks.onReady();
          }
          if (
            m.type === "session.input_transcript.delta" &&
            typeof m.delta === "string"
          ) {
            this.callbacks.onInputTranscript?.(m.delta);
            this.callbacks.onTranscript("user", m.delta);
          }
          if (
            m.type === "session.output_transcript.delta" &&
            typeof m.delta === "string"
          )
            this.outputTranscript(
              m.delta,
              Number.isFinite(m.start_ms) &&
                Number.isFinite(m.end_ms) &&
                m.start_ms >= 0 &&
                m.end_ms >= m.start_ms
                ? { startMs: m.start_ms, endMs: m.end_ms }
                : undefined,
            );
          if (
            m.type === "session.delegation.created" &&
            m.delegation?.target === "client"
          )
            this.callbacks.onDelegation(m.delegation.id);
          if (m.type === "session.usage.updated") {
            this.seconds = m.usage?.seconds ?? this.seconds;
            this.callbacks.onUsage?.(this.seconds);
          }
          if (m.type === "session.closed") {
            this.seconds = m.usage?.seconds ?? this.seconds;
            this.finish(true);
          }
          if (m.type === "error")
            this.callbacks.onError(m.error?.message ?? "Live 会话错误");
        } catch {
          this.callbacks.onError("无法读取 Live 事件");
        }
      };
      this.peer.onconnectionstatechange = () => {
        this.callbacks.onDiagnostic?.(`WebRTC: ${this.peer?.connectionState}`);
        if (this.peer?.connectionState === "failed") {
          this.callbacks.onError("语音连接中断");
          void this.close();
        }
      };
      const offer = await this.peer.createOffer();
      await this.peer.setLocalDescription(offer);
      const result = await create(offer.sdp!);
      if (this.finished) throw Error("语音连接已取消");
      await this.peer.setRemoteDescription({
        type: "answer",
        sdp: result.transport.sdp,
      });
      await started;
    } catch (err) {
      this.rejectStart?.(err instanceof Error ? err : Error(String(err)));
      this.finish(false);
      throw err;
    }
  }
  /** Fills `levels` with the answer voice's speech bands; false unless it is audible. */
  levels(levels: Float32Array) {
    if (
      !this.output ||
      !this.ready ||
      this.closing ||
      this.outputMode !== "play"
    )
      return false;
    readSpeechLevels(this.output, levels);
    return true;
  }
  append(
    type: "thinking" | "commentary" | "instructions",
    content: string,
    delegationId: string | null = null,
  ) {
    if (this.ready && !this.closing && this.channel?.readyState === "open")
      for (const part of content.match(/[^]{1,220}/gu) ?? [])
        this.channel.send(
          JSON.stringify({
            type: `session.${type}.append`,
            event_id: crypto.randomUUID(),
            delegation_id: delegationId,
            content: part,
          }),
        );
  }
  /** Arm once per pending turn; partial recognition must never reset its prefix. */
  prepareOutput() {
    if (this.outputMode === "discard") this.setOutput("hold");
  }
  /** Ignored bystander speech must not interrupt an already accepted reply. */
  discardPendingOutput() {
    if (this.outputMode === "hold" || this.outputMode === "overflow")
      this.setOutput("discard");
  }
  mute(muted: boolean) {
    if (muted) this.setOutput("discard");
    else if (this.outputMode !== "overflow") this.setOutput("play");
  }
  private setOutput(command: OutputCommand) {
    this.outputMode =
      command === "play" ? "play" : command === "hold" ? "hold" : "discard";
    if (command === "discard") {
      this.pendingTranscript = [];
      this.pendingTranscriptChars = 0;
      this.transcriptOpen = false;
      this.outputActive = false;
    }
    this.outputQueue?.port.postMessage({ command, epoch: ++this.outputEpoch });
    this.callbacks.onDiagnostic?.(`Live output buffer: ${this.outputMode}`);
  }
  private outputTranscript(text: string, timing?: TranscriptTiming) {
    if (this.outputMode === "discard" || this.outputMode === "overflow") return;
    // Captions and WebRTC packets have no shared word/packet IDs. Pace delayed
    // captions against received/played PCM, rather than releasing the entire
    // held reply's text as soon as its first syllable starts. This is approximate.
    if (this.pendingTranscriptChars + text.length > 32000) {
      this.setOutput("discard");
      this.callbacks.onError(
        "Voice reply captions exceeded the buffer. Please ask again.",
      );
      return;
    }
    this.pendingTranscript.push({
      text,
      frame: this.outputBuffer?.receivedFrames ?? 0,
      timing,
    });
    this.pendingTranscriptChars += text.length;
    this.flushOutputTranscript();
  }
  private flushOutputTranscript() {
    if (this.outputMode !== "play" || !this.transcriptOpen) return;
    const through = this.outputBuffer?.playedThroughFrame ?? 0;
    while (
      this.pendingTranscript.length &&
      this.pendingTranscript[0].frame <= through
    ) {
      const part = this.pendingTranscript.shift()!;
      this.pendingTranscriptChars -= part.text.length;
      this.callbacks.onTranscript("assistant", part.text, part.timing);
    }
  }
  interrupt() {
    this.setOutput("discard");
    this.append(
      "instructions",
      "The user is asking a new question. Stop the old answer, listen, then respond in the language of their new utterance.",
    );
  }
  input(enabled: boolean) {
    this.mic
      ?.getTracks()
      .forEach((t) => (t.enabled = enabled && !this.closing));
    this.callbacks.onDiagnostic?.(
      `Live microphone sending: ${enabled && !this.closing}`,
    );
  }
  /** On-demand metadata only. Never reads or records microphone samples. */
  async diagnostics() {
    const track = this.mic?.getAudioTracks()[0];
    const state = {
      ready: this.ready,
      closing: this.closing,
      connection: this.peer?.connectionState,
      ice: this.peer?.iceConnectionState,
      dataChannel: this.channel?.readyState,
      inputEnabled: track?.enabled,
      inputMuted: track?.muted,
      inputState: track?.readyState,
      output: this.outputBuffer,
      outputGate: this.outputMode,
      pendingTranscriptChars: this.pendingTranscriptChars,
    };
    const audio: Record<string, unknown>[] = [];
    try {
      const stats = await this.peer?.getStats();
      stats?.forEach((report) => {
        if (report.kind !== "audio") return;
        if (report.type === "outbound-rtp")
          audio.push({
            type: report.type,
            bytesSent: report.bytesSent,
            packetsSent: report.packetsSent,
          });
        if (report.type === "media-source")
          audio.push({
            type: report.type,
            audioLevel: report.audioLevel,
            totalAudioEnergy: report.totalAudioEnergy,
            totalSamplesDuration: report.totalSamplesDuration,
          });
      });
      return { ...state, audio };
    } catch {
      return { ...state, statsUnavailable: true };
    }
  }
  close(): Promise<void> {
    if (this.closedPromise) return this.closedPromise;
    if (this.finished) return Promise.resolve();
    this.closedPromise = new Promise(
      (resolve) => (this.resolveClose = resolve),
    );
    this.closing = true;
    this.setOutput("discard");
    this.input(false);
    if (this.ready) this.sendClose();
    // If creation is in flight, retain the channel long enough to close on session.started.
    this.closeTimer = window.setTimeout(
      () => this.finish(false),
      this.ready ? 5000 : 35000,
    );
    return this.closedPromise;
  }
  private sendClose() {
    if (this.channel?.readyState === "open")
      this.channel.send(JSON.stringify({ type: "session.close" }));
  }
  private finish(finalized: boolean) {
    if (this.finished) return;
    this.finished = true;
    this.rejectStart?.(Error("语音会话已结束"));
    this.cleanup();
    this.callbacks.onClose(finalized, this.seconds);
    this.resolveClose?.();
  }
  private cleanup() {
    clearTimeout(this.startTimer);
    clearTimeout(this.closeTimer);
    this.ready = false;
    this.channel?.close();
    this.peer?.close();
    this.mic?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.outputQueue?.disconnect();
    this.outputQueue?.port.close();
    this.pendingTranscript = [];
    this.pendingTranscriptChars = 0;
    this.receiver.pause();
    this.receiver.srcObject = null;
  }
}
