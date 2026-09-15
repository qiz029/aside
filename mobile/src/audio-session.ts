export interface NativeAudioSession {
  configure(recording: boolean): Promise<void>;
  activate(active: boolean): Promise<void>;
}
/** One native session; ownership prevents late cleanup from stopping a newer source. */
export class AudioSessionCoordinator {
  private queue = Promise.resolve();
  private owner: symbol | "podcast" | null = null;
  private revision = 0;
  constructor(private native: NativeAudioSession) {}
  private transition(owner: symbol | "podcast" | null, recording: boolean) {
    this.owner = owner;
    const revision = ++this.revision;
    const operation = this.queue
      .catch(() => {})
      .then(async () => {
        if (revision !== this.revision) return;
        await this.native.configure(recording);
        if (revision !== this.revision) return;
        await this.native.activate(owner !== null);
      });
    this.queue = operation;
    return operation;
  }
  playPodcast() {
    return this.transition("podcast", false);
  }
  pausePodcast() {
    if (typeof this.owner === "symbol") return Promise.resolve();
    return this.transition(null, false);
  }
  record(owner: symbol) {
    return this.transition(owner, true);
  }
  answer(owner: symbol) {
    return this.owner === owner
      ? this.transition(owner, false)
      : Promise.resolve();
  }
  finishQuestion(owner: symbol) {
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
