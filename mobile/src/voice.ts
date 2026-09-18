import { AudioModule, RecordingPresets } from "expo-audio";
import { NativeEventEmitter, NativeModules, Platform } from "react-native";
import {
  RTCPeerConnection,
  mediaDevices,
  type MediaStream,
  type MediaStreamTrack,
} from "react-native-webrtc";
import { File } from "expo-file-system";
import type {
  VoiceLifecycleConfig,
  MicrophoneConfig,
} from "@aside/engine/core";
import type {
  VoiceCallbacks,
  VoiceFactory,
  VoicePort,
} from "@aside/player-runtime/ports";
import type { AudioCoordinator } from "./audio";
import type { AudioFile } from "./api";
import { createSilentTrack } from "./silent-track";
import { NativeAudioOutput } from "./native-audio-output";
type Remote = Parameters<VoiceFactory>[3];
const recordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  numberOfChannels: 1,
  sampleRate: 48000,
  bitRate: 64000,
};
/** Automatic duplex listening and manual AAC capture share the native output gate. */
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
  private inputStream?: MediaStream;
  private generation = 0;
  private capturing = false;
  private closed = false;
  private recording = Promise.resolve();
  private maxTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private abort?: AbortController;
  private sessionId = "";
  private seconds = 0;
  private output = false;
  private muted = true;
  private pcm: NativeAudioOutput;
  private closeWait?: () => void;
  private finalized = false;
  private working = false;
  private readonly audioOwner = Symbol("voice");
  private interruption?: { remove(): void };
  constructor(
    private cb: VoiceCallbacks,
    private remote: Remote,
    private coordinator: AudioCoordinator,
    private lifecycle: VoiceLifecycleConfig,
    private manual = true,
    microphone?: MicrophoneConfig,
  ) {
    this.pcm = new NativeAudioOutput(
      {
        ...cb,
        onOutput: (active) => {
          this.output = active;
          this.activity();
          cb.onOutput(active);
        },
        onError: (message) => {
          cb.onError(message);
          void this.close();
        },
      },
      manual ? undefined : microphone,
    );
    this.interruption = new NativeEventEmitter(
      NativeModules.AsideAudioSession,
    ).addListener("AsideAnswerInterrupted", () => {
      if (!this.isEnabled || this.closed) return;
      if (this.cb.onInterruption) this.cb.onInterruption();
      else this.cb.onError("音频已被系统中断 / Audio was interrupted");
      void this.close();
    });
  }
  async enable() {
    this.isEnabled = true;
    this.closed = false;
    if (this.manual) this.cb.onStatus("armed");
    else {
      this.cb.onStatus("connecting");
      try {
        await this.coordinator.listen(this.audioOwner);
        if (this.closed) return;
        await this.connect();
        if (!this.closed) this.cb.onStatus("on");
      } catch (error) {
        console.warn(
          "Aside native voice startup failed",
          error instanceof Error ? error.stack : String(error),
        );
        this.cb.onError(String(error));
        await this.close();
      }
    }
  }
  beginManual() {
    if (!this.manual || !this.isEnabled || this.capturing) return false;
    this.cancelCapture();
    this.capturing = true;
    this.activity();
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
          if (this.abort === abort) this.abort = undefined;
          this.activity();
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
    await this.pcm.start();
    if (this.closed) return;
    const peer = (this.peer = new RTCPeerConnection({}));
    {
      // Android's native AudioRecord adapter supplies a silent media clock in
      // manual mode. recvonly has no RTP clock and GPT-Live never speaks.
      const stream =
        Platform.OS === "ios"
          ? undefined
          : await mediaDevices.getUserMedia({ audio: true, video: false });
      const track = stream
        ? stream.getAudioTracks()[0]
        : await createSilentTrack();
      if (!track) {
        stream?.release();
        throw Error("Microphone track is unavailable");
      }
      if (this.closed) {
        track.stop();
        stream?.release(false);
        track.release();
        peer.close();
        return;
      }
      this.inputStream = stream;
      this.silence = track;
      peer.addTrack(track);
    }
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
      if (this.closed) {
        track.enabled = false;
        return;
      }
      this.tracks.push(track);
      // Keep decoding while held; admission happens at the PCM gate so the
      // answer's prefix survives a late server control event.
      track.enabled = true;
    };
    channel.onmessage = (event: { data: unknown }) => {
      try {
        const m = JSON.parse(String(event.data));
        if (this.closed && m.type !== "session.closed") return;
        if (m.type === "session.started") {
          this.ready = true;
          this.isCold = false;
          // Capture owns progress until both transcription and Live are ready.
          this.cb.onReady();
          this.append(
            "instructions",
            "Speak the app-provided final answer verbatim, preserving every word and number. Do not translate, paraphrase, add a closing question, or repeat it. After the final answer, listen silently for a follow-up; the app owns playback and its waiting time.",
          );
          resolve();
          if (this.closed) this.send({ type: "session.close" });
        }
        if (
          m.type === "session.output_transcript.delta" &&
          typeof m.delta === "string"
        ) {
          this.activity();
          this.pcm.transcript(
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
        }
        if (
          !this.manual &&
          m.type === "session.input_transcript.delta" &&
          typeof m.delta === "string"
        ) {
          this.cb.onInputTranscript?.(m.delta);
          this.cb.onTranscript("user", m.delta);
        }
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
          if (this.finalized) return;
          this.finalized = true;
          this.ready = false;
          this.closeWait?.();
          this.cb.onClose(true, this.seconds, this.sessionId, this.closed);
          // Expiry is terminal for this peer. The next hold creates a new
          // native voice and negotiates a fresh server-owned session.
          if (!this.closed) void this.close();
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
        void this.close();
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
    this.activity();
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
    this.pcm.mute(value);
  }
  prepareOutput() {
    this.pcm.prepare();
  }
  discardPendingOutput() {
    this.pcm.discardPending();
  }
  inputLevel() {
    return this.pcm.inputLevel();
  }
  async diagnostics() {
    return { manual: this.manual, audio: this.pcm.diagnostics() };
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
    if (!this.manual) return;
    const generation = ++this.generation;
    this.capturing = false;
    clearTimeout(this.maxTimer);
    this.abort?.abort();
    this.abort = undefined;
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
  activity() {
    clearTimeout(this.idleTimer);
    // Manual mode can release an unused paid connection without changing
    // playback. Automatic mode keeps its input clock across conversations.
    if (
      this.manual &&
      this.ready &&
      !this.closed &&
      !this.capturing &&
      !this.abort &&
      !this.working &&
      !this.output
    )
      this.idleTimer = setTimeout(() => {
        void this.close();
      }, this.lifecycle.idleCloseMs);
  }
  setWorking(value: boolean) {
    this.working = value;
    this.activity();
  }
  playbackResumed() {
    this.mute(true);
    if (this.manual) void this.close();
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.interruption?.remove();
    this.interruption = undefined;
    this.isEnabled = false;
    // Revoke capture before waiting for the supplier's session.closed event.
    const releaseAudio = this.manual
      ? Promise.resolve()
      : this.coordinator
          .finishQuestion(this.audioOwner)
          .catch((error) => this.cb.onError(String(error)));
    this.cancelCapture();
    this.mute(true);
    this.pcm.close();
    // Local media must stop before the potentially slow supplier close ack.
    // A replacement peer shares the native ADM; old remote tracks must never
    // feed its new PCM queue or keep sending microphone input during teardown.
    for (const track of this.tracks) track.enabled = false;
    this.silence?.stop();
    this.inputStream?.release(false);
    this.inputStream = undefined;
    this.silence?.release();
    this.silence = undefined;
    clearTimeout(this.idleTimer);
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
    await releaseAudio;
    this.cb.onStatus("off");
    if (!this.finalized)
      this.cb.onClose(false, this.seconds, this.sessionId, true);
  }
}
export const nativeVoiceFactory =
  (coordinator: AudioCoordinator): VoiceFactory =>
  (mic, config, cb, remote, manual) =>
    new NativeVoice(cb, remote, coordinator, config, manual, mic);
