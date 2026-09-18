import type { MicrophoneConfig } from "@aside/engine/core";
import { MicrophoneBuffer } from "./microphone-buffer";
export interface MicrophonePort {
  stream: MediaStream;
  start(): Promise<void>;
  begin(): void;
  snapshot(): Blob;
  discard(): void;
  stop(): void;
  inputLevel?(): number;
  diagnostics?(): unknown;
}
export class LocalMicrophone implements MicrophonePort {
  stream!: MediaStream;
  private context?: AudioContext;
  private vad?: import("@ricky0123/vad-web").MicVAD;
  private node?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private sink?: GainNode;
  private buffer?: MicrophoneBuffer;
  private stopped = false;
  private frames = 0;
  private lastFrameAt = 0;
  private rms = 0;
  private speechProbability?: number;
  private observe(frame: Float32Array, probability?: number) {
    this.frames++;
    this.lastFrameAt = Date.now();
    this.rms = Math.sqrt(
      frame.reduce((sum, value) => sum + value * value, 0) / frame.length,
    );
    this.speechProbability = probability;
  }
  diagnostics() {
    const track = this.stream?.getAudioTracks()[0];
    return {
      device: track?.label,
      trackState: track?.readyState,
      enabled: track?.enabled,
      muted: track?.muted,
      audioContext: this.context?.state,
      frames: this.frames,
      lastFrameAgeMs: this.lastFrameAt ? Date.now() - this.lastFrameAt : null,
      rms: this.rms,
      speechProbability: this.speechProbability,
      stopped: this.stopped,
    };
  }
  /** Read the existing capture meter; never acquire a device just to draw UI. */
  inputLevel() {
    const track = this.stream?.getAudioTracks()[0];
    if (
      this.stopped ||
      this.context?.state !== "running" ||
      track?.readyState !== "live" ||
      !track.enabled ||
      track.muted ||
      Date.now() - this.lastFrameAt > 250
    )
      return 0;
    return this.rms;
  }
  constructor(
    private config: MicrophoneConfig,
    private preRollMs: number,
    private onSpeech: (active: boolean) => void,
    private onError: (message: string) => void,
  ) {}
  async start() {
    try {
      // Resume within the playback click, before model loading can outlive user activation.
      const context = (this.context = new AudioContext());
      await context.resume();
      if (this.stopped) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (this.stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.stream = stream;
      stream.getAudioTracks().forEach(
        (t) =>
          (t.onended = () => {
            if (!this.stopped) this.onError("麦克风已断开，请重新开始播放");
          }),
      );
      if (this.config.vadEnabled !== false) {
        const { MicVAD } = await import("@ricky0123/vad-web");
        if (this.stopped) return;
        this.buffer = new MicrophoneBuffer(16000, this.config, this.preRollMs);
        const vad = await MicVAD.new({
          model: "v5",
          audioContext: context,
          startOnLoad: false,
          baseAssetPath: "/vad/",
          onnxWASMBasePath: "/vad/",
          ortConfig: (ort) => {
            ort.env.wasm.numThreads = 1;
          },
          getStream: async () => stream,
          pauseStream: async () => {},
          resumeStream: async () => stream,
          onFrameProcessed: (probabilities, frame) => {
            if (this.stopped) return;
            this.observe(frame, probabilities.isSpeech);
            const event = this.buffer!.push(frame, probabilities.isSpeech);
            if (event === "overflow")
              this.onError(
                `首句录音超过 ${(this.config.maxCaptureMs ?? 60000) / 1000} 秒，请分成较短的问题。`,
              );
            else if (event) this.onSpeech(event === "start");
          },
        });
        await vad.start();
        this.vad = vad;
        if (vad.errored) throw Error(vad.errored);
        if (this.stopped) {
          await vad.destroy();
          this.vad = undefined;
        }
        return;
      }

      await context.audioWorklet.addModule("/microphone-worklet.js");
      if (this.stopped) return;
      this.buffer = new MicrophoneBuffer(
        context.sampleRate,
        this.config,
        this.preRollMs,
      );
      this.node = new AudioWorkletNode(context, "aside-capture");
      this.node.port.onmessage = (e) => {
        if (this.stopped) return;
        this.observe(e.data);
        const event = this.buffer!.push(e.data);
        if (event === "overflow")
          this.onError(
            `首句录音超过 ${(this.config.maxCaptureMs ?? 60000) / 1000} 秒，请分成较短的问题。`,
          );
        else if (event) this.onSpeech(event === "start");
      };
      this.source = context.createMediaStreamSource(stream);
      this.sink = context.createGain();
      this.sink.gain.value = 0;
      this.source
        .connect(this.node)
        .connect(this.sink)
        .connect(context.destination);
      stream.getAudioTracks().forEach(
        (t) =>
          (t.onended = () => {
            if (!this.stopped) this.onError("麦克风已断开，请重新开启语音");
          }),
      );
      await context.resume();
    } catch (error) {
      this.stop();
      throw error;
    }
  }
  begin() {
    this.buffer?.begin();
  }
  snapshot() {
    if (!this.buffer) throw Error("麦克风未就绪");
    return this.buffer.snapshot();
  }
  discard() {
    this.buffer?.discard();
  }
  stop() {
    this.stopped = true;
    void this.vad?.destroy().catch(() => {});
    this.vad = undefined;
    this.node?.port.close();
    this.node?.disconnect();
    this.source?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.context?.state !== "closed") void this.context?.close();
    this.buffer?.clear();
  }
}

/** Ask at entry, then release the device until the user starts playback. */
export async function requestMicrophonePermission(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((track) => track.stop());
}
