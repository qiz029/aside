import { DEFAULT_PLAYER_CONFIG, type PlayerConfig } from "@aside/engine/player";

import { readSpeechLevels } from "./audio-levels";
import type { PodcastAudio } from "@aside/player-runtime/ports";
export type { PodcastAudio };
/** The DOM reference stays here; UI code only binds it. */
export class BrowserPodcastAudio implements PodcastAudio {
  private element: HTMLAudioElement | null = null;
  private config: PlayerConfig = DEFAULT_PLAYER_CONFIG;
  private context?: AudioContext;
  private analyser?: AnalyserNode;
  private gain?: GainNode;
  private sources = new WeakMap<
    HTMLAudioElement,
    MediaElementAudioSourceNode
  >();
  private routed?: MediaElementAudioSourceNode;
  /** Attention multiplier on top of the configured volume: the target while ramping through Web Audio, the current value otherwise. */
  private level = 1;
  private fade?: () => void;
  private generation = 0;
  private settling = false;
  attach = (element: HTMLAudioElement | null) => {
    this.element = element;
    this.generation++;
    this.settling = false;
    this.fade?.();
    this.fade = undefined;
    this.level = 1;
    this.configure(this.config);
  };
  get positionMs() {
    return (this.element?.currentTime ?? 0) * 1000;
  }
  get isLoaded() {
    return (this.element?.readyState ?? 0) >= 1;
  }
  set positionMs(value: number) {
    if (this.element) this.element.currentTime = value / 1000;
  }
  play(fadeInMs = 0) {
    const element = this.element;
    if (!element) return Promise.reject(Error("节目音频未就绪"));
    this.generation++;
    this.settling = false;
    this.ramp(1, fadeInMs, fadeInMs > 0 ? 0 : undefined);
    const playing = element.play();
    this.route(element);
    return playing;
  }
  pause() {
    this.generation++;
    this.settling = false;
    this.element?.pause();
    this.ramp(1, 0);
  }
  configure(config: PlayerConfig) {
    this.config = config;
    if (!this.element) return;
    this.element.defaultPlaybackRate = config.playbackRate;
    this.element.playbackRate = config.playbackRate;
    this.element.preservesPitch = config.preservesPitch;
    this.element.muted = config.muted;
    this.applyVolume();
  }
  duck(level: number, durationMs: number) {
    if (this.settling || !this.element) return;
    this.ramp(Math.max(0, Math.min(1, level)), durationMs);
  }
  async settle(durationMs: number) {
    const element = this.element;
    if (!element) return;
    if (element.paused) {
      this.pause();
      return;
    }
    const generation = ++this.generation;
    this.settling = true;
    this.ramp(0, durationMs);
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    if (this.generation !== generation) return;
    this.pause();
  }
  /** Fills `levels` with the podcast's live speech bands; false while nothing plays through the analyser. */
  levels(levels: Float32Array) {
    const { element, analyser, context } = this;
    if (
      !element ||
      element.paused ||
      !analyser ||
      context?.state !== "running" ||
      this.sources.get(element) !== this.routed
    )
      return false;
    readSpeechLevels(analyser, levels);
    return true;
  }
  private usingGain() {
    return (
      !!this.gain &&
      !!this.element &&
      !!this.routed &&
      this.sources.get(this.element) === this.routed
    );
  }
  private applyVolume() {
    if (!this.element) return;
    this.element.volume =
      this.config.volume * (this.usingGain() ? 1 : this.level);
  }
  /**
   * Moves the attention multiplier. Through Web Audio the ramp is sample
   * accurate; before the element is routed it steps `element.volume`.
   */
  private ramp(target: number, durationMs: number, start?: number) {
    this.fade?.();
    this.fade = undefined;
    const from = start ?? this.level;
    this.level = target;
    const { gain, context } = this;
    if (gain && context && this.usingGain()) {
      const now = context.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(start ?? gain.gain.value, now);
      if (durationMs > 0)
        gain.gain.linearRampToValueAtTime(target, now + durationMs / 1000);
      else gain.gain.setValueAtTime(target, now);
      return;
    }
    if (durationMs <= 0 || !this.element) {
      this.applyVolume();
      return;
    }
    const startedAt = performance.now();
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      const progress = Math.min(
        1,
        (performance.now() - startedAt) / durationMs,
      );
      this.level = from + (target - from) * progress;
      this.applyVolume();
      if (progress < 1) timer = setTimeout(step, 16);
      else this.fade = undefined;
    };
    timer = setTimeout(step, 16);
    this.fade = () => clearTimeout(timer);
  }
  /**
   * Sends the element through a gain (attention) node and an analyser. Web
   * Audio owns the output once connected, so only connect when the context is
   * running and never silence it.
   */
  private route(element: HTMLAudioElement) {
    if (typeof AudioContext === "undefined") return;
    let context: AudioContext;
    try {
      context = this.context ??= new AudioContext();
    } catch {
      return;
    }
    void context
      .resume()
      .then(() => {
        if (context.state !== "running" || this.element !== element) return;
        let source = this.sources.get(element);
        if (source && source === this.routed) return;
        if (!source) {
          source = context.createMediaElementSource(element);
          this.sources.set(element, source);
        }
        if (!this.analyser) {
          this.analyser = context.createAnalyser();
          this.analyser.fftSize = 2048;
          this.analyser.smoothingTimeConstant = 0.55;
          this.analyser.connect(context.destination);
        }
        if (!this.gain) {
          this.gain = context.createGain();
          this.gain.connect(this.analyser);
        }
        this.routed?.disconnect();
        source.connect(this.gain);
        this.routed = source;
        // Hand the attention level over from element.volume to the gain node.
        this.fade?.();
        this.fade = undefined;
        this.gain.gain.cancelScheduledValues(context.currentTime);
        this.gain.gain.setValueAtTime(this.level, context.currentTime);
        this.applyVolume();
      })
      .catch(() => {});
  }
}
