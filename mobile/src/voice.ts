import { AudioModule, RecordingPresets } from "expo-audio";
import { Platform } from "react-native";
import { RTCPeerConnection, type MediaStreamTrack } from "react-native-webrtc";
import { File } from "expo-file-system";
import type {
  VoiceCallbacks,
  VoiceFactory,
  VoicePort,
} from "@aside/player-runtime/ports";
import type { AudioCoordinator } from "./audio";
import type { AudioFile } from "./api";
type Remote = Parameters<VoiceFactory>[3];
const recordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  numberOfChannels: 1,
  sampleRate: 48000,
  bitRate: 64000,
};
/** Manual capture never publishes a microphone track to WebRTC. */
export class NativeVoice implements VoicePort {
  isEnabled = false;
  isCold = true;
  private ready = false;
  get isWarm() {
    return this.ready;
  }
  private recorder = new AudioModule.AudioRecorder({
    ...recordingOptions,
    ...(Platform.OS === "ios"
      ? recordingOptions.ios
      : recordingOptions.android),
  });
  private peer?: RTCPeerConnection;
  private channel?: ReturnType<RTCPeerConnection["createDataChannel"]>;
  private tracks: MediaStreamTrack[] = [];
  private generation = 0;
  private capturing = false;
  private closed = false;
  private recording = Promise.resolve();
  private maxTimer?: ReturnType<typeof setTimeout>;
  private statsTimer?: ReturnType<typeof setInterval>;
  private abort?: AbortController;
  private sessionId = "";
  private seconds = 0;
  private output = false;
  private lastSound = 0;
  private muted = true;
  private lastEnergy = 0;
  private closeWait?: () => void;
  private working = false;
  private readonly audioOwner = Symbol("voice");
  constructor(
    private cb: VoiceCallbacks,
    private remote: Remote,
    private coordinator: AudioCoordinator,
  ) {}
  async enable() {
    this.isEnabled = true;
    this.closed = false;
    this.cb.onStatus("armed");
  }
  beginManual() {
    if (!this.isEnabled || this.capturing) return false;
    this.cancelCapture();
    this.capturing = true;
    const generation = ++this.generation;
    this.cb.onSpeech(true);
    this.cb.onStatus("arming");
    this.recording = this.recording
      .then(() => this.coordinator.record(this.audioOwner))
      .then(async () => {
        if (!this.capturing || generation !== this.generation) return;
        await this.recorder.prepareToRecordAsync(recordingOptions);
        if (!this.capturing || generation !== this.generation) {
          await this.recorder.stop().catch(() => {});
          return;
        }
        this.recorder.record({ forDuration: 30 });
        // The iOS SDK can return without throwing when the host input fails.
        // Never show a recording timer unless the native recorder actually started.
        if (!this.recorder.isRecording)
          throw Error("麦克风无法开始录音 / Couldn't start the microphone");
        this.cb.onStatus("armed");
        this.maxTimer = setTimeout(() => this.endManual(), 29500);
      })
      .catch((error) => {
        if (generation === this.generation) {
          this.cancelCapture();
          this.cb.onError(String(error));
        }
      });
    return true;
  }
  endManual() {
    if (!this.capturing) return;
    this.capturing = false;
    clearTimeout(this.maxTimer);
    const generation = this.generation;
    void this.recording
      .then(async () => {
        const duration = this.recorder.currentTime;
        await this.recorder.stop();

        const uri = this.recorder.uri;
        if (generation !== this.generation || !uri) return;
        if (duration < 0.25)
          throw Error(
            "录音尚未准备好，请再次按住 / Hold again after the microphone is ready",
          );
        await this.coordinator.answer(this.audioOwner);
        this.cb.onSpeech(false);
        this.cb.onStatus("transcribing");
        const file = new File(uri);
        const abort = (this.abort = new AbortController());
        try {
          const [text] = await Promise.all([
            this.remote.transcribe(
              {
                uri,
                name: "question.m4a",
                mimeType: "audio/mp4",
                size: file.size,
              } satisfies AudioFile,
              abort.signal,
            ),
            this.connect(),
          ]);
          if (generation !== this.generation || abort.signal.aborted) return;
          this.mute(false);
          this.cb.onFirstQuestion(text);
        } finally {
          if (file.exists) file.delete();
        }
      })
      .catch((error) => {
        if (generation === this.generation) {
          this.cb.onError(String(error));
          void this.close();
        }
      });
  }
  private async connect() {
    if (this.ready) return;
    this.cb.onStatus("connecting");
    const peer = (this.peer = new RTCPeerConnection({}));
    peer.addTransceiver("audio", { direction: "recvonly" });
    const channel = (this.channel = peer.createDataChannel("oai-events"));
    let resolve!: () => void, reject!: (error: Error) => void;
    const started = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void started.catch(() => {});
    const timeout = setTimeout(
      () => reject(Error("语音连接启动超时 / Voice connection timed out")),
      30000,
    );
    peer.ontrack = (event: unknown) => {
      const track = (event as { track: MediaStreamTrack }).track;
      this.tracks.push(track);
      track.enabled = !this.muted;
    };
    channel.onmessage = (event: { data: unknown }) => {
      try {
        const m = JSON.parse(String(event.data));
        if (m.type === "session.started") {
          this.ready = true;
          this.cb.onStatus("on");
          this.cb.onReady();
          resolve();
          if (this.closed) this.send({ type: "session.close" });
        }
        if (
          m.type === "session.output_transcript.delta" &&
          typeof m.delta === "string"
        )
          this.cb.onTranscript("assistant", m.delta);
        if (
          m.type === "session.delegation.created" &&
          m.delegation?.target === "client"
        )
          this.cb.onDelegation(m.delegation.id);
        if (m.type === "session.usage.updated") {
          this.seconds = m.usage?.seconds ?? this.seconds;
          this.cb.onUsage?.(this.seconds, this.sessionId);
        }
        if (m.type === "session.closed") {
          this.ready = false;
          this.closeWait?.();
          this.cb.onClose(true, this.seconds, this.sessionId, this.closed);
        }
        if (m.type === "error")
          this.cb.onError(m.error?.message ?? "Voice error");
      } catch {
        this.cb.onError("无法读取语音事件 / Invalid voice event");
      }
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "failed" && !this.closed) {
        reject(Error("Voice disconnected"));
        this.cb.onError("语音连接中断 / Voice disconnected");
      }
    };
    try {
      const offer = await peer.createOffer({});
      await peer.setLocalDescription(offer);
      const result = await this.remote.create(offer.sdp!);
      this.sessionId = result.session.id;
      if (this.closed) {
        this.cb.onClose(false, this.seconds, this.sessionId, true);
        throw Error("Voice closed");
      }
      await peer.setRemoteDescription({
        type: "answer",
        sdp: result.transport.sdp,
      });
      await started;
      let polling = false;
      this.statsTimer = setInterval(() => {
        if (polling) return;
        polling = true;
        void peer
          .getStats()
          .then((stats) => {
            let measured = false,
              energy = 0;
            stats.forEach((r: Record<string, unknown>) => {
              if (
                r.type === "inbound-rtp" &&
                (r.kind === "audio" || r.mediaType === "audio") &&
                typeof r.totalAudioEnergy === "number"
              ) {
                measured = true;
                energy += r.totalAudioEnergy;
              }
            });
            if (!measured) return; // No reliable playback evidence: leave resumption manual.
            if (energy > this.lastEnergy && !this.muted) {
              this.lastSound = Date.now();
              if (!this.output) {
                this.output = true;
                this.cb.onOutput(true);
              }
            }
            this.lastEnergy = energy;
            if (this.output && Date.now() - this.lastSound > 1200) {
              this.output = false;
              this.cb.onOutput(false);
            }
          })
          .catch(() => {})
          .finally(() => {
            polling = false;
          });
      }, 100);
    } finally {
      clearTimeout(timeout);
    }
  }
  private send(data: unknown) {
    if (this.channel?.readyState === "open")
      this.channel.send(JSON.stringify(data));
  }
  append(
    type: "thinking" | "commentary" | "instructions",
    content: string,
    id: string | null = null,
  ) {
    if (!this.ready || this.closed) return;
    for (const part of content.match(/[^]{1,220}/gu) ?? [])
      this.send({
        type: `session.${type}.append`,
        event_id: crypto.randomUUID(),
        delegation_id: id,
        content: part,
      });
  }
  mute(value: boolean) {
    this.muted = value;
    this.tracks.forEach((t) => {
      t.enabled = !value;
    });
  }
  interrupt() {
    this.mute(true);
    this.output = false;
    this.append(
      "instructions",
      "Stop the old answer. The user is asking another question.",
    );
  }
  cancelCapture() {
    const generation = ++this.generation;
    this.capturing = false;
    clearTimeout(this.maxTimer);
    this.abort?.abort();
    this.recording = this.recording
      .catch(() => {})
      .then(async () => {
        await this.recorder.stop().catch(() => {});
        const uri = this.recorder.uri;
        if (uri) {
          const file = new File(uri);
          if (file.exists) file.delete();
        }
        if (generation === this.generation && !this.capturing) {
          await this.coordinator.answer(this.audioOwner);
          if (!this.ready)
            await this.coordinator.finishQuestion(this.audioOwner);
        }
      });
  }
  activity() {}
  setWorking(value: boolean) {
    this.working = value;
  }
  playbackResumed() {
    void this.close();
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.isEnabled = false;
    this.cancelCapture();
    this.mute(true);
    clearInterval(this.statsTimer);
    if (this.ready) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        this.closeWait = () => {
          clearTimeout(timer);
          resolve();
        };
        this.send({ type: "session.close" });
      });
    }
    this.ready = false;
    this.channel?.close();
    this.peer?.close();
    this.tracks = [];
    await this.recording.catch(() => {});
    await this.coordinator.finishQuestion(this.audioOwner);
    this.cb.onStatus("off");
    this.cb.onClose(false, this.seconds, this.sessionId, true);
  }
}
export const nativeVoiceFactory =
  (coordinator: AudioCoordinator): VoiceFactory =>
  (_mic, _config, cb, remote) =>
    new NativeVoice(cb, remote, coordinator);
