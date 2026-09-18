import { AudioModule, RecordingPresets } from "expo-audio";
import { NativeEventEmitter, NativeModules, Platform } from "react-native";
import { RTCPeerConnection, type MediaStreamTrack } from "react-native-webrtc";
import { File } from "expo-file-system";
import type {
  VoiceCallbacks,
  VoiceFactory,
  VoicePort,
} from "@aside/player-runtime/ports";
import type { AudioCoordinator } from "./audio";
import type { AudioFile } from "./api";
import { createSilentTrack } from "./silent-track";
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
  private connecting?: Promise<void>;
  private channel?: ReturnType<RTCPeerConnection["createDataChannel"]>;
  private tracks: MediaStreamTrack[] = [];
  private silence?: MediaStreamTrack;
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
  private lastSamplesDuration = 0;
  private closeWait?: () => void;
  private working = false;
  private readonly audioOwner = Symbol("voice");
  private interruption?: { remove(): void };
  constructor(
    private cb: VoiceCallbacks,
    private remote: Remote,
    private coordinator: AudioCoordinator,
  ) {
    if (Platform.OS === "ios")
      this.interruption = new NativeEventEmitter(
        NativeModules.AsideAudioSession,
      ).addListener("AsideAnswerInterrupted", () => {
        if (!this.isEnabled || this.closed) return;
        this.cb.onError("音频已被系统中断 / Audio was interrupted");
        void this.close();
      });
  }
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
            this.remote
              .transcribe(
                {
                  uri,
                  name: "question.m4a",
                  mimeType: "audio/mp4",
                  size: file.size,
                } satisfies AudioFile,
                abort.signal,
              )
              .then((text) => {
                if (generation !== this.generation || abort.signal.aborted)
                  return "";
                const question = text.trim();
                if (!question)
                  throw Error(
                    "没有识别到语音，请再按住说一次 / No speech was recognized. Hold to try again",
                  );
                this.cb.onQuestionRecognized?.(question);
                if (!this.ready) this.cb.onStatus("connecting");
                return question;
              }),
            this.connect(),
          ]);
          if (generation !== this.generation || abort.signal.aborted) return;
          this.cb.onStatus("on");
          this.mute(false);
          this.append(
            "thinking",
            `Latest actual user utterance (locally transcribed, pending backend result): ${text}`,
          );
          this.append(
            "instructions",
            "The app is handling this locally recorded question. Wait silently for its backend result; do not delegate it again. Use the language of the latest actual user utterance for the spoken answer. Preserve the backend answer's language and concise length.",
          );
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
  private connect(): Promise<void> {
    if (this.ready) return Promise.resolve();
    // A new hold can supersede ASR while the same cold session is negotiating.
    // Share that negotiation; creating a second peer leaks the first session
    // and lets its late events modify the current answer.
    if (!this.connecting) {
      const pending = this.openConnection();
      this.connecting = pending;
      void pending
        .finally(() => {
          if (this.connecting === pending) this.connecting = undefined;
        })
        .catch(() => {});
    }
    return this.connecting;
  }
  private async openConnection() {
    const peer = (this.peer = new RTCPeerConnection({}));
    if (Platform.OS === "ios") {
      const track = await createSilentTrack();
      if (this.closed) {
        track.stop();
        track.release();
        peer.close();
        return;
      }
      this.silence = track;
      peer.addTrack(track);
    } else peer.addTransceiver("audio", { direction: "recvonly" });
    const channel = (this.channel = peer.createDataChannel("oai-events"));
    let resolve!: () => void, reject!: (error: Error) => void;
    const started = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void started.catch(() => {});
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, fail) => {
      timeout = setTimeout(
        () => fail(Error("语音连接启动超时 / Voice connection timed out")),
        30000,
      );
    });
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
          // Capture owns progress until both transcription and Live are ready.
          this.cb.onReady();
          resolve();
          if (this.closed) this.send({ type: "session.close" });
        }
        if (
          m.type === "session.output_transcript.delta" &&
          typeof m.delta === "string"
        )
          this.cb.onTranscript(
            "assistant",
            m.delta,
            typeof m.start_ms === "number" &&
              Number.isFinite(m.start_ms) &&
              m.start_ms >= 0 &&
              typeof m.end_ms === "number" &&
              Number.isFinite(m.end_ms) &&
              m.end_ms >= m.start_ms
              ? { startMs: m.start_ms, endMs: m.end_ms }
              : undefined,
          );
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
      // Include HTTP negotiation in the deadline: waiting only on `started`
      // leaves the UI stuck forever when the session request never returns.
      await Promise.race([
        (async () => {
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
        })(),
        deadline,
      ]);
      let polling = false;
      this.statsTimer = setInterval(() => {
        if (polling) return;
        polling = true;
        void peer
          .getStats()
          .then((stats) => {
            let measured = false,
              energy = 0,
              duration = 0;
            stats.forEach((r: Record<string, unknown>) => {
              if (
                r.type === "inbound-rtp" &&
                (r.kind === "audio" || r.mediaType === "audio") &&
                typeof r.totalAudioEnergy === "number" &&
                typeof r.totalSamplesDuration === "number"
              ) {
                measured = true;
                energy += r.totalAudioEnergy;
                duration += r.totalSamplesDuration;
              }
            });
            if (!measured) return; // No reliable playback evidence: leave resumption manual.
            // Opus comfort noise has nonzero energy. Treating any increase as
            // speech kept the answer "playing" forever and prevented resume.
            const elapsed = duration - this.lastSamplesDuration;
            const rms =
              elapsed > 0
                ? Math.sqrt(Math.max(0, energy - this.lastEnergy) / elapsed)
                : 0;
            if (rms > 0.001 && !this.muted) {
              this.lastSound = Date.now();
              if (!this.output) {
                this.output = true;
                this.cb.onOutput(true);
              }
            }
            this.lastEnergy = energy;
            this.lastSamplesDuration = duration;
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
          if (this.ready) await this.coordinator.answer(this.audioOwner);
          else await this.coordinator.finishQuestion(this.audioOwner);
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
    this.interruption?.remove();
    this.interruption = undefined;
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
    this.silence?.stop();
    this.silence?.release();
    this.silence = undefined;
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
