import type { PlayerConfig } from "@aside/engine/player";
import { NativeModules, Platform } from "react-native";
import {
  AudioModule,
  createAudioPlayer,
  setAudioModeAsync,
  setIsAudioActiveAsync,
} from "expo-audio";
import type { PodcastAudio } from "@aside/player-runtime/ports";
import { AudioSessionCoordinator, NativePlaybackEvents } from "./audio-session";
/** Serializes transitions between media playback, capture and live response audio. */
export class AudioCoordinator extends AudioSessionCoordinator {
  constructor() {
    super({
      configure: async (recording, continuous, voice) => {
        // Reconfigure only after the previous audio unit has stopped. iOS can
        // reject activation when switching a still-active voice session.
        await setIsAudioActiveAsync(false);
        await setAudioModeAsync({
          allowsRecording: recording,
          playsInSilentMode: true,
          shouldPlayInBackground: !recording || !!continuous,
          // A foreground voice lease owns Android focus for both media and RTC.
          // Expo resumes ownership when that lease closes.
          interruptionMode:
            Platform.OS === "android" && voice ? "mixWithOthers" : "doNotMix",
          shouldRouteThroughEarpiece: false,
        });
      },
      activate: setIsAudioActiveAsync,
      enableAnswer: async (enabled) => {
        await NativeModules.AsideAudioSession.setAnswerEnabled(enabled);
      },
      enableInput: async (enabled) => {
        await NativeModules.AsideAudioSession.setInputEnabled(enabled);
      },
      enableFocus: async (enabled) => {
        if (Platform.OS === "android")
          await NativeModules.AsideAudioSession.setVoiceFocusEnabled(enabled);
      },
    });
  }
}
export class NativePodcastAudio implements PodcastAudio {
  // Expo's delayed auto-deactivation can shut down a recorder started after pause.
  // The coordinator owns activation and release across all three audio sources.
  readonly player = createAudioPlayer(null, {
    updateInterval: 250,
    keepAudioSessionActive: true,
  });
  readonly events = new NativePlaybackEvents();
  private target: number | undefined;
  private playRevision = 0;
  private cancelLoading?: () => void;
  private config?: PlayerConfig;
  /** Attention multiplier on top of the configured volume. */
  private level = 1;
  private fade?: () => void;
  private settling = false;
  private settleGeneration = 0;
  constructor(readonly coordinator: AudioCoordinator) {
    coordinator.bindPodcast({
      pause: () => {
        this.events.requestedPause();
        this.player.pause();
      },
      resume: () => {
        this.events.requestedPlay();
        this.player.play();
      },
    });
  }
  get positionMs() {
    return this.target ?? this.player.currentTime * 1000;
  }
  set positionMs(value: number) {
    void this.seek(value);
  }
  async seek(value: number) {
    this.target = value;
    try {
      await this.player.seekTo(value / 1000, 0, 0);
    } finally {
      this.target = undefined;
    }
  }
  load(url: string, headers: Record<string, string>, title: string) {
    this.pause();
    this.player.replace({ uri: url, headers });
    this.player.setActiveForLockScreen(
      true,
      { title, artist: "Aside" },
      { showSeekBackward: true, showSeekForward: true },
    );
  }
  async play() {
    const revision = ++this.playRevision;
    this.settleGeneration++;
    this.settling = false;
    this.ramp(1, 0);
    this.events.requestedPlay();
    this.cancelLoading?.();
    if (!this.player.isLoaded) {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timeout);
          subscription.remove();
          this.cancelLoading = undefined;
          error ? reject(error) : resolve();
        };
        const subscription = this.player.addListener(
          "playbackStatusUpdate",
          (status) => {
            if (status.isLoaded) finish();
            else if (status.playbackState === "failed")
              finish(Error("Audio could not be loaded. Please try again."));
          },
        );
        const timeout = setTimeout(
          () =>
            finish(
              Error(
                "Audio loading timed out. Check your connection and try again.",
              ),
            ),
          30000,
        );
        this.cancelLoading = () => finish();
        if (this.player.isLoaded) finish();
      });
    }
    if (revision !== this.playRevision) return;
    await this.coordinator.playPodcast();
    if (revision === this.playRevision) this.player.play();
  }
  pause() {
    this.events.requestedPause();
    this.playRevision++;
    this.settleGeneration++;
    this.settling = false;
    this.cancelLoading?.();
    this.player.pause();
    this.ramp(1, 0);
    void this.coordinator.pausePodcast().catch(() => {});
  }
  configure(config: PlayerConfig) {
    this.config = config;
    this.player.shouldCorrectPitch = config.preservesPitch;
    this.applyVolume();
    this.player.muted = config.muted;
    this.player.setPlaybackRate(config.playbackRate);
  }
  duck(level: number, durationMs: number) {
    if (this.settling) return;
    this.ramp(Math.max(0, Math.min(1, level)), durationMs);
  }
  async settle(durationMs: number) {
    if (!this.player.playing) {
      this.pause();
      return;
    }
    const generation = ++this.settleGeneration;
    this.settling = true;
    this.ramp(0, durationMs);
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    if (generation !== this.settleGeneration) return;
    this.pause();
  }
  private applyVolume() {
    this.player.volume = (this.config?.volume ?? 1) * this.level;
  }
  /** Steps the attention multiplier; expo-audio exposes no scheduled volume ramps. */
  private ramp(target: number, durationMs: number) {
    this.fade?.();
    this.fade = undefined;
    const from = this.level;
    this.level = target;
    if (durationMs <= 0) {
      this.applyVolume();
      return;
    }
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      const progress = Math.min(1, (Date.now() - startedAt) / durationMs);
      this.level = from + (target - from) * progress;
      this.applyVolume();
      if (progress < 1) timer = setTimeout(step, 16);
      else this.fade = undefined;
    };
    timer = setTimeout(step, 16);
    this.fade = () => clearTimeout(timer);
  }
  clear() {
    this.pause();
    this.player.setActiveForLockScreen(false);
    // SDK 54 Android rejects replace(null). A bundled silent source releases
    // the authenticated media item while preserving the global player/listeners.
    this.player.replace(require("../assets/silence.wav"));
  }
  dispose() {
    this.clear();
    this.player.remove();
  }
}
export async function microphonePermission() {
  const current = await AudioModule.getRecordingPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) throw Error("Microphone permission denied");
  const requested = await AudioModule.requestRecordingPermissionsAsync();
  if (!requested.granted && !requested.canAskAgain)
    throw Error("Microphone permission denied");
  return false;
}
