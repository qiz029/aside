import { Records } from "./records.js";
import type { Episode, Analysis, Passage } from "@aside/engine/core";
import { partialAnalysis, type TranscriptReader } from "../../backend/src/transcript-reader.js";
import { HttpError } from "./http.js";
import { storedAudio, PODCAST_DOWNLOAD_LIMIT } from "./storage.js";
export interface EpisodeRow {
  id: string;
  owner_id: string;
  public: number;
  metadata: string;
  analysis_key: string | null;
  workflow_id: string | null;
  deleted_at: number | null;
}
export class CloudStore {
  readonly records: Records;
  constructor(
    readonly db: D1Database,
    readonly bucket: R2Bucket,
  ) {
    this.records = new Records(db);
  }
  async list(owner: string) {
    const { results } = await this.db
      .prepare(
        "SELECT metadata FROM episodes WHERE deleted_at IS NULL AND (owner_id=? OR public=1) ORDER BY created_at DESC LIMIT 100",
      )
      .bind(owner)
      .all<{ metadata: string }>();
    return results.map((row) => JSON.parse(row.metadata) as Episode);
  }
  async row(id: string, owner?: string) {
    const row = await this.db
      .prepare("SELECT * FROM episodes WHERE id=?")
      .bind(id)
      .first<EpisodeRow>();
    if (!row || row.deleted_at !== null || (owner !== undefined && row.owner_id !== owner && !row.public))
      throw new HttpError(404, "节目不存在");
    return row;
  }
  async episode(row: EpisodeRow): Promise<Episode> {
    const episode = JSON.parse(row.metadata) as Episode;
    if (row.analysis_key) {
      const analysis = await this.records.get<Analysis>(row.analysis_key);
      if (!analysis) throw new HttpError(503, "分析结果暂不可用");
      episode.analysis = analysis;
    } else {
      const prefix = `episodes/${episode.id}/analysis-v1`;
      const manifest = await this.records.get<{ plan: { offsetMs: number; durationMs: number }[] }>(`${prefix}/manifest.json`);
      const plan = manifest?.plan ?? [];
      const committed = await this.records.list<Passage[]>(`${prefix}/transcript-`);
      const chunks = plan.map((_, i) => committed.get(`${prefix}/transcript-${i}.json`));
      episode.analysis = partialAnalysis(episode, plan, chunks);
    }
    return episode;
  }
  transcriptReader(id: string, owner?: string): TranscriptReader {
    return {
      read: async () => (await this.episode(await this.row(id, owner))).analysis!,
      prioritize: async (atMs) => {
        await this.row(id, owner);
        await this.records.put(`episodes/${id}/transcript-priority`, atMs);
      },
    };
  }
  async create(owner: string, episode: Episode) {
    await this.db
      .prepare(
        "INSERT INTO episodes(id,owner_id,metadata,created_at) VALUES(?,?,?,?)",
      )
      .bind(episode.id, owner, JSON.stringify(episode), episode.createdAt)
      .run();
  }
  async findPodcast(owner: string, feed: string, guid: string): Promise<Episode | undefined> {
    const row = await this.db.prepare("SELECT metadata FROM episodes WHERE owner_id=? AND deleted_at IS NULL AND json_extract(metadata,'$.podcast.feedUrl')=? AND json_extract(metadata,'$.podcast.guid')=? LIMIT 1")
      .bind(owner, feed, guid).first<{ metadata: string }>();
    return row ? JSON.parse(row.metadata) : undefined;
  }
  async createPodcast(owner: string, episode: Episode, accountLimit: number, globalLimit: number): Promise<Episode> {
    if (!episode.podcast) throw Error("Missing podcast metadata");
    episode.podcast.reservedBytes = PODCAST_DOWNLOAD_LIMIT;
    const inserted = await this.db.prepare(`INSERT INTO episodes(id,owner_id,metadata,created_at)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM episodes WHERE owner_id=? AND deleted_at IS NULL AND json_extract(metadata,'$.podcast.feedUrl')=? AND json_extract(metadata,'$.podcast.guid')=?)
      AND COALESCE((SELECT SUM(size) FROM ${storedAudio} WHERE owner_id=?),0)+?<=?
      AND COALESCE((SELECT SUM(size) FROM ${storedAudio}),0)+?<=? RETURNING id`)
      .bind(episode.id, owner, JSON.stringify(episode), episode.createdAt, owner, owner, episode.podcast.feedUrl, episode.podcast.guid, owner, PODCAST_DOWNLOAD_LIMIT, accountLimit, PODCAST_DOWNLOAD_LIMIT, globalLimit)
      .first();
    if (inserted) return episode;
    const existing = await this.findPodcast(owner, episode.podcast.feedUrl, episode.podcast.guid);
    if (existing) return existing;
    throw new HttpError(429, "播客缓存空间不足，请删除不需要的音频后重试 / Podcast storage limit reached");
  }
  async update(episode: Episode, analysisKey?: string) {
    const { analysis, ...metadata } = episode;
    const result = await this.db
      .prepare(
        "UPDATE episodes SET metadata=?,analysis_key=COALESCE(?,analysis_key) WHERE id=? AND deleted_at IS NULL",
      )
      .bind(JSON.stringify(metadata), analysisKey ?? null, episode.id)
      .run();
    if (!result.meta.changes) throw new HttpError(404, "节目不存在");
  }
  /** Atomic reservation. Failed calls also consume quota; no client-reported refunds. */
  async reserve(bucket: string, limit: number) {
    const result = await this.db
      .prepare(
        `INSERT INTO budgets(bucket,used) VALUES(?,1)
      ON CONFLICT(bucket) DO UPDATE SET used=used+1 WHERE used < ? RETURNING used`,
      )
      .bind(bucket, limit)
      .first();
    if (!result) throw new HttpError(429, "今日体验额度已用完，请明天再试");
  }
}
export function positiveLimit(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new HttpError(503, "服务端额度配置无效");
  return n;
}
