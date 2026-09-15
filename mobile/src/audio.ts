import type { PlayerConfig } from "@aside/engine/player";
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
      configure: (recording) =>
        setAudioModeAsync({
          allowsRecording: recording,
          playsInSilentMode: true,
          shouldPlayInBackground: !recording,
          interruptionMode: "doNotMix",
          shouldRouteThroughEarpiece: false,
        }),
      activate: setIsAudioActiveAsync,
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
  constructor(readonly coordinator: AudioCoordinator) {}
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
    this.cancelLoading?.();
    this.player.pause();
    void this.coordinator.pausePodcast().catch(() => {});
  }
  configure(config: PlayerConfig) {
    this.player.shouldCorrectPitch = config.preservesPitch;
    this.player.volume = config.volume;
    this.player.muted = config.muted;
    this.player.setPlaybackRate(config.playbackRate);
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
