import { z } from "zod";
import type { Episode } from "@aside/engine/core";

const recentSchema = z.object({
  id: z.string(),
  title: z.string(),
  durationMs: z.number().finite().nonnegative(),
  positionMs: z.number().finite().nonnegative(),
  cover: z.boolean(),
});
export type RecentEpisode = z.infer<typeof recentSchema>;
type Storage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<unknown>;
  removeItem(key: string): Promise<unknown>;
};

/** Account-scoped summaries only; playback checkpoints remain authoritative. */
export class RecentListening {
  private key: string | null = null;
  private restoringKey: string | null = null;
  private revision = 0;
  private items: RecentEpisode[] = [];
  private listeners = new Set<() => void>();
  private writes = Promise.resolve<unknown>(undefined);
  constructor(private storage: Storage) {}
  getSnapshot = () => this.items;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(items: RecentEpisode[]) {
    this.items = items;
    this.listeners.forEach((listener) => listener());
  }
  async restore(owner: string) {
    const revision = ++this.revision;
    this.key = null;
    this.publish([]);
    const key = `aside.recent.${owner}`;
    this.restoringKey = key;
    await this.writes.catch(() => {});
    const raw = await this.storage.getItem(key);
    if (revision !== this.revision) return;
    let items: RecentEpisode[] = [];
    try {
      items = z
        .array(recentSchema)
        .max(6)
        .parse(JSON.parse(raw ?? "[]"));
    } catch {
      /* A stale or damaged cache must not prevent listening. */
    }
    this.key = key;
    this.restoringKey = null;
    this.publish(items);
  }
  remember(episode: Episode, positionMs: number) {
    const key = this.key;
    if (!key || episode.status !== "ready") return Promise.resolve();
    const item: RecentEpisode = {
      id: episode.id,
      title: episode.title,
      durationMs: episode.durationMs,
      positionMs: Math.max(0, Math.min(episode.durationMs, positionMs)),
      cover: !!episode.cover,
    };
    const items = [
      item,
      ...this.items.filter((old) => old.id !== item.id),
    ].slice(0, 6);
    this.publish(items);
    this.writes = this.writes
      .catch(() => {})
      .then(() => this.storage.setItem(key, JSON.stringify(items)));
    return this.writes;
  }
  async clear() {
    const key = this.key ?? this.restoringKey;
    ++this.revision;
    this.key = null;
    this.restoringKey = null;
    this.publish([]);
    this.writes = this.writes
      .catch(() => {})
      .then(() => (key ? this.storage.removeItem(key) : undefined));
    await this.writes;
  }
}
