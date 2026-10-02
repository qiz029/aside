import { SqliteObjects } from "./object-storage.js";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Episode } from "@aside/engine/core";
import type { Passage } from "@aside/engine/core";
import { partialAnalysis, type TranscriptReader } from "./transcript-reader.js";
export class Store {
  readonly db: DatabaseSync;
  readonly objects: SqliteObjects;
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(resolve(root, "aside.sqlite"));
    this.objects = new SqliteObjects(this.db);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS artifacts(episode_id TEXT NOT NULL,name TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(episode_id,name))",
    );
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS episodes(id TEXT PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS checkpoints(id TEXT PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS voice_usage(id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, seconds REAL NOT NULL, finalized INTEGER NOT NULL);",
    );
  }
  list(): Episode[] {
    return this.db
      .prepare("SELECT json FROM episodes ORDER BY rowid DESC")
      .all()
      .map((r) => JSON.parse(String(r.json)));
  }
  get(id: string): Episode | undefined {
    const r = this.db.prepare("SELECT json FROM episodes WHERE id=?").get(id);
    if (!r) return undefined;
    const episode: Episode = JSON.parse(String(r.json));
    if (!episode.analysis || episode.analysis.transcript) {
      const plan =
        this.artifact<{ offsetMs: number; durationMs: number }[]>(
          id,
          "transcript-plan",
        ) ?? [];
      episode.analysis = partialAnalysis(
        episode,
        plan,
        plan.map((_, i) => this.artifact<Passage[]>(id, `transcript-v1-${i}`)),
      );
    }
    return episode;
  }
  transcriptReader(id: string): TranscriptReader {
    return {
      read: async () => {
        const episode = this.get(id);
        if (!episode) throw Error("节目不存在");
        return episode.analysis!;
      },
      prioritize: async (atMs) => {
        this.saveArtifact(id, "transcript-priority", atMs);
      },
    };
  }
  put(e: Episode) {
    this.db
      .prepare(
        "INSERT INTO episodes VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json",
      )
      .run(e.id, JSON.stringify(e));
  }
  checkpoint(id: string, value?: unknown) {
    if (value !== undefined)
      this.db
        .prepare(
          "INSERT INTO checkpoints VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json",
        )
        .run(id, JSON.stringify(value));
    const row = this.db
      .prepare("SELECT json FROM checkpoints WHERE id=?")
      .get(id);
    return row ? JSON.parse(String(row.json)) : null;
  }
  recordUsage(
    episodeId: string,
    sessionId: string,
    seconds: number,
    finalized: boolean,
  ) {
    this.db
      .prepare(
        "INSERT INTO voice_usage VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET seconds=MAX(voice_usage.seconds,excluded.seconds),finalized=MAX(voice_usage.finalized,excluded.finalized)",
      )
      .run(sessionId, episodeId, seconds, finalized ? 1 : 0);
  }
  usage(episodeId: string) {
    return this.db
      .prepare(
        "SELECT id as sessionId,seconds,finalized FROM voice_usage WHERE episode_id=? ORDER BY rowid",
      )
      .all(episodeId);
  }
  artifact<T>(episode: string, name: string): T | undefined {
    const row = this.db
      .prepare("SELECT json FROM artifacts WHERE episode_id=? AND name=?")
      .get(episode, name);
    return row ? (JSON.parse(String(row.json)) as T) : undefined;
  }
  saveArtifact(episode: string, name: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO artifacts VALUES(?,?,?) ON CONFLICT(episode_id,name) DO UPDATE SET json=excluded.json",
      )
      .run(episode, name, JSON.stringify(value));
  }
  close() {
    this.db.close();
  }
}
