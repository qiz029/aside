export interface NativeAudioSession {
  configure(
    recording: boolean,
    continuous?: boolean,
    voice?: boolean,
  ): Promise<void>;
  activate(active: boolean): Promise<void>;
  enableAnswer?(enabled: boolean): Promise<void>;
  enableInput?(enabled: boolean): Promise<void>;
  enableFocus?(enabled: boolean): Promise<void>;
}
/** One native session; ownership prevents late cleanup from stopping a newer source. */
export class AudioSessionCoordinator {
  private queue = Promise.resolve();
  private owner: symbol | "podcast" | null = null;
  private revision = 0;
  private continuousOwner?: symbol;
  private podcastPlaying = false;
  private podcast?: { pause(): void; resume(): void };
  constructor(private native: NativeAudioSession) {}
  /** Preserve media intent while a native category/focus change pauses its player. */
  bindPodcast(transport: { pause(): void; resume(): void }) {
    this.podcast = transport;
  }
  private transition(
    owner: symbol | "podcast" | null,
    recording: boolean,
    continuous = false,
  ) {
    this.owner = owner;
    const revision = ++this.revision;
    const operation = this.queue
      .catch(() => {})
      .then(async () => {
        if (revision !== this.revision) return;
        const preservePlayback = this.podcastPlaying;
        if (preservePlayback) this.podcast?.pause();
        // Muting a remote track leaves WebRTC's audio unit running. Stop it
        // before Expo changes AVAudioSession or prepares the next recording.
        await this.native.enableAnswer?.(false);
        if (revision !== this.revision) return;
        await this.native.enableInput?.(false);
        if (revision !== this.revision) return;
        await this.native.enableFocus?.(false);
        if (revision !== this.revision) return;
        await this.native.configure(
          recording,
          continuous,
          typeof owner === "symbol",
        );
        if (revision !== this.revision) return;
        await this.native.activate(owner !== null);
        if (revision !== this.revision) return;
        await this.native.enableFocus?.(typeof owner === "symbol");
        if (revision !== this.revision) return;
        if (continuous) await this.native.enableInput?.(true);
        if (revision !== this.revision) return;
        if (typeof owner === "symbol" && (!recording || continuous))
          await this.native.enableAnswer?.(true);
        if (
          revision === this.revision &&
          preservePlayback &&
          this.podcastPlaying
        )
          this.podcast?.resume();
      });
    this.queue = operation;
    return operation;
  }
  playPodcast() {
    this.podcastPlaying = true;
    if (this.continuousOwner) return this.queue;
    return this.transition("podcast", false);
  }
  pausePodcast() {
    this.podcastPlaying = false;
    if (typeof this.owner === "symbol") return Promise.resolve();
    return this.transition(null, false);
  }
  record(owner: symbol) {
    this.continuousOwner = undefined;
    return this.transition(owner, true);
  }
  /** One foreground duplex lease survives duck, pause and semantic resume. */
  listen(owner: symbol) {
    this.continuousOwner = owner;
    return this.transition(owner, true, true);
  }
  answer(owner: symbol) {
    if (this.continuousOwner === owner) return this.queue;
    return this.owner === owner
      ? this.transition(owner, false)
      : Promise.resolve();
  }
  finishQuestion(owner: symbol) {
    if (this.continuousOwner === owner) {
      this.continuousOwner = undefined;
      return this.transition(this.podcastPlaying ? "podcast" : null, false);
    }
    return this.owner === owner
      ? this.transition(null, false)
      : Promise.resolve();
  }
}

/** Distinguishes delayed command acknowledgements from system transport actions. */
export class NativePlaybackEvents {
  private intent: "paused" | "pausing" | "starting" | "playing" = "paused";
  requestedPlay() {
    this.intent = "starting";
  }
  requestedPause() {
    this.intent = "pausing";
  }
  observe(status: {
    playing: boolean;
    isLoaded: boolean;
    isBuffering: boolean;
  }): "play" | "pause" | null {
    if (!status.isLoaded || status.isBuffering) return null;
    if (this.intent === "pausing") {
      if (!status.playing) this.intent = "paused";
      return null;
    }
    if (this.intent === "starting") {
      if (status.playing) this.intent = "playing";
      return null;
    }
    if (status.playing && this.intent === "paused") {
      this.intent = "playing";
      return "play";
    }
    if (!status.playing && this.intent === "playing") {
      this.intent = "paused";
      return "pause";
    }
    return null;
  }
}
