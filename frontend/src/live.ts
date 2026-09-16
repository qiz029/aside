import type { Turn } from "@aside/engine/core";
import { readSpeechLevels } from "./audio-levels";
export interface LiveCallbacks {
  onReady(): void;
  onOutput(active: boolean): void;
  onTranscript(role: Turn["role"], text: string): void;
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
  private audio = new Audio();
  private timer?: number;
  private closeTimer?: number;
  private ready = false;
  private closing = false;
  private outputActive = false;
  private lastOutput = 0;
  private startTimer?: number;
  private resolveStart?: () => void;
  private rejectStart?: (error: Error) => void;
  private finished = false;
  private closedPromise?: Promise<void>;
  private resolveClose?: () => void;
  private seconds = 0;
  private blockedUntilQuiet = false;
  private desiredMuted = false;
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
      this.peer = new RTCPeerConnection();
      this.audio.autoplay = true;
      this.peer.ontrack = (e) => {
        const stream = e.streams[0] ?? new MediaStream([e.track]);
        this.audio.srcObject = stream;
        void this.audio
          .play()
          .catch(() => this.callbacks.onError("请点击页面允许音频播放"));
        const output = (this.output = this.ctx!.createAnalyser());
        output.fftSize = 1024;
        this.ctx!.createMediaStreamSource(stream).connect(output);
      };
      for (const track of this.mic.getTracks())
        this.peer.addTrack(track, this.mic);
      this.channel = this.peer.createDataChannel("oai-events");
      this.channel.onmessage = (e) => {
        try {
          const m = JSON.parse(e.data);
          if (typeof m.type === "string" && m.type !== "session.usage.updated")
            this.callbacks.onDiagnostic?.(`Live event: ${m.type.slice(0, 100)}`);
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
            this.callbacks.onTranscript("assistant", m.delta);
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
      const rms = (a: AnalyserNode) => {
        const data = new Float32Array(a.fftSize);
        a.getFloatTimeDomainData(data);
        return Math.sqrt(data.reduce((n, x) => n + x * x, 0) / data.length);
      };
      this.timer = window.setInterval(() => {
        if (!this.ready || this.closing) return;
        const now = performance.now();
        const output = this.output;
        const loud = output && rms(output) > 0.008;
        if (loud) {
          this.lastOutput = now;
          if (!this.outputActive && !this.blockedUntilQuiet) {
            this.outputActive = true;
            this.callbacks.onOutput(true);
          }
        } else if (now - this.lastOutput > 900) {
          if (this.blockedUntilQuiet) {
            this.blockedUntilQuiet = false;
            this.audio.muted = this.desiredMuted;
          }
          if (this.outputActive) {
            this.outputActive = false;
            this.callbacks.onOutput(false);
          }
        }
      }, 40);
      await started;
    } catch (err) {
      this.rejectStart?.(err instanceof Error ? err : Error(String(err)));
      this.finish(false);
      throw err;
    }
  }
  /** Fills `levels` with the answer voice's speech bands; false unless it is audible. */
  levels(levels: Float32Array) {
    if (!this.output || !this.ready || this.closing || this.audio.muted)
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
  mute(muted: boolean) {
    this.desiredMuted = muted;
    this.audio.muted = muted || this.blockedUntilQuiet;
  }
  interrupt() {
    this.audio.muted = true;
    this.blockedUntilQuiet = true;
    this.outputActive = false;
    this.append(
      "instructions",
      "The user is asking a new question. Stop the old answer, listen, then respond in the language of their new utterance.",
    );
  }
  input(enabled: boolean) {
    this.mic
      ?.getTracks()
      .forEach((t) => (t.enabled = enabled && !this.closing));
    this.callbacks.onDiagnostic?.(`Live microphone sending: ${enabled && !this.closing}`);
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
    };
    const audio: Record<string, unknown>[] = [];
    try {
      const stats = await this.peer?.getStats();
      stats?.forEach((report) => {
        if (report.kind !== "audio") return;
        if (report.type === "outbound-rtp")
          audio.push({ type: report.type, bytesSent: report.bytesSent, packetsSent: report.packetsSent });
        if (report.type === "media-source")
          audio.push({ type: report.type, audioLevel: report.audioLevel, totalAudioEnergy: report.totalAudioEnergy, totalSamplesDuration: report.totalSamplesDuration });
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
    this.audio.muted = true;
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
    clearInterval(this.timer);
    clearTimeout(this.closeTimer);
    this.ready = false;
    this.channel?.close();
    this.peer?.close();
    this.mic?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.audio.srcObject = null;
  }
}
