import type {
  PodcastShow,
  PodcastShowPage,
  PodcastSubscriptions,
} from "@aside/engine/contracts";
export interface PodcastDirectory {
  searchPodcasts(
    query: string,
    country: string,
  ): Promise<{ shows: PodcastShow[] }>;
  podcastShow(id: string, country: string): Promise<PodcastShowPage>;
  podcastSubscriptions(): Promise<PodcastSubscriptions>;
  subscribePodcast(
    id: string,
    country: string,
    subscribed: boolean,
  ): Promise<unknown>;
}
export class PodcastDiscovery {
  state = {
    results: [] as PodcastShow[],
    searched: false,
    show: null as PodcastShowPage | null,
    subscriptions: { subscriptions: [], episodes: [] } as PodcastSubscriptions,
    busy: false,
    error: "",
  };
  private listeners = new Set<() => void>();
  private versions = { view: 0, subscriptions: 0 };
  private active = new Set<string>();
  private mutation = false;
  constructor(private api: PodcastDirectory) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(value: Partial<typeof this.state>) {
    this.state = { ...this.state, ...value };
    this.listeners.forEach((fn) => fn());
  }
  dispose() {
    this.versions.view++;
    this.versions.subscriptions++;
    this.active.clear();
    this.listeners.clear();
  }
  private async run(
    action: () => Promise<Partial<typeof this.state>>,
    lane: keyof typeof this.versions = "view",
  ) {
    const version = ++this.versions[lane];
    this.active.add(lane);
    this.set({ busy: true, error: "" });
    try {
      const result = await action();
      if (version === this.versions[lane]) this.set(result);
    } catch (error) {
      if (version === this.versions[lane])
        this.set({
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (version === this.versions[lane]) {
        this.active.delete(lane);
        this.set({ busy: this.active.size > 0 });
      }
    }
  }
  search(query: string, country: string) {
    return this.run(async () => ({
      results: (await this.api.searchPodcasts(query.trim(), country)).shows,
      searched: true,
      show: null,
    }));
  }
  open(show: PodcastShow) {
    return this.run(async () => ({
      show: await this.api.podcastShow(show.id, show.country),
    }));
  }
  back() {
    this.versions.view++;
    this.active.delete("view");
    this.set({ show: null, busy: this.active.size > 0, error: "" });
  }
  refresh() {
    if (this.mutation) return Promise.resolve();
    return this.run(
      async () => ({ subscriptions: await this.api.podcastSubscriptions() }),
      "subscriptions",
    );
  }
  async toggle(show: PodcastShow) {
    if (this.mutation) return;
    this.mutation = true;
    try {
      await this.run(async () => {
        const subscribed = this.state.subscriptions.subscriptions.some(
          (item) => item.show.id === show.id,
        );
        await this.api.subscribePodcast(show.id, show.country, !subscribed);
        return { subscriptions: await this.api.podcastSubscriptions() };
      }, "subscriptions");
    } finally {
      this.mutation = false;
    }
  }
}
