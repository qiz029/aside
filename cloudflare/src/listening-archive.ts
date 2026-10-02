import { z } from "zod";
import type { Episode } from "@aside/engine/core";
import {
  archivedConversationSchema,
  archivedTurnSchema,
  listeningEventSchema,
  mergeHeardRanges,
  type HeardRange,
} from "@aside/engine/contracts";
import { HttpError, json, readJson } from "./http.js";
import type { CloudStore } from "./store.js";

const activeUser =
  "EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL)";
const accessibleEpisode =
  "EXISTS(SELECT 1 FROM episodes WHERE id=? AND deleted_at IS NULL AND (public=1 OR owner_id=?))";

interface ConversationRow {
  id: string;
  episode_id: string;
  at_ms: number;
  created_at: number;
  ordinal: number;
}

function integerParam(
  url: URL,
  key: string,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
) {
  const raw = url.searchParams.get(key);
  if (raw === null) return fallback;
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(Number(raw)) ||
    Number(raw) > max
  )
    throw new HttpError(400, `Invalid ${key}`);
  return Number(raw);
}

function pageSize(url: URL) {
  const size = integerParam(url, "limit", 20, 100);
  if (!size) throw new HttpError(400, "Invalid limit");
  return size;
}

function conflict() {
  return new HttpError(
    409,
    "记录 ID 或顺序已被使用，请勿更改已保存的内容",
    "archive_conflict",
  );
}

function withinEpisode(positions: number[], episode: Episode) {
  if (episode.durationMs <= 0 || positions.some((n) => n > episode.durationMs))
    throw new HttpError(400, "时间位置超出节目范围");
}

function conversationView(row: ConversationRow) {
  return {
    id: row.id,
    episodeId: row.episode_id,
    atMs: row.at_ms,
    createdAt: row.created_at,
  };
}

/** Account-only durable archive. Authorization is rechecked on every resource. */
export async function listeningArchiveRoute(
  request: Request,
  owner: string,
  store: CloudStore,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const db = store.db;
  const method = request.method;
  const episode = async (id: string) =>
    JSON.parse((await store.row(id, owner)).metadata) as Episode;
  const conversation = async (id: string) => {
    const row = await db
      .prepare("SELECT * FROM conversations WHERE owner_id=? AND id=?")
      .bind(owner, id)
      .first<ConversationRow>();
    if (!row) throw new HttpError(404, "对话不存在");
    await store.row(row.episode_id, owner);
    return row;
  };

  const eventMatch = /^\/api\/space\/listening\/events\/([^/]+)$/.exec(path);
  if (eventMatch && method === "PUT") {
    const id = z.uuid().parse(eventMatch[1]);
    const data = listeningEventSchema.parse(await readJson(request));
    withinEpisode([data.startMs, data.endMs], await episode(data.episodeId));
    if (data.endedAt > Date.now() + 60_000)
      throw new HttpError(400, "收听时间不能在未来");
    const payload = JSON.stringify(data);
    const saved = await db
      .prepare(
        `INSERT INTO listening_events
      (owner_id,id,episode_id,session_id,started_at,ended_at,start_ms,end_ms,payload,received_at)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${activeUser} AND ${accessibleEpisode}
      ON CONFLICT(owner_id,id) DO NOTHING RETURNING id`,
      )
      .bind(
        owner,
        id,
        data.episodeId,
        data.sessionId,
        data.startedAt,
        data.endedAt,
        data.startMs,
        data.endMs,
        payload,
        Date.now(),
        owner,
        data.episodeId,
        owner,
      )
      .first();
    const existing = await db
      .prepare("SELECT payload FROM listening_events WHERE owner_id=? AND id=?")
      .bind(owner, id)
      .first<{ payload: string }>();
    if (!existing || existing.payload !== payload) throw conflict();
    return json({ id, ...data }, saved ? 201 : 200);
  }

  if (path === "/api/space/listening" && method === "GET") {
    const limit = pageSize(url);
    const cursor = url.searchParams.get("cursor");
    const match = cursor?.match(/^(\d+)\|([a-zA-Z0-9-]{1,100})$/);
    if (cursor && (!match || !Number.isSafeInteger(Number(match[1]))))
      throw new HttpError(400, "Invalid cursor");
    const rows = await db
      .prepare(
        `SELECT l.episode_id, e.metadata,
      MIN(l.started_at) AS first_listened_at, MAX(l.ended_at) AS last_listened_at,
      SUM(l.ended_at-l.started_at) AS listened_ms, COUNT(DISTINCT l.session_id) AS sessions
      FROM listening_events l JOIN episodes e ON e.id=l.episode_id
      WHERE l.owner_id=? AND e.deleted_at IS NULL AND (e.public=1 OR e.owner_id=?)
      GROUP BY l.episode_id
      HAVING MAX(l.ended_at)<? OR (MAX(l.ended_at)=? AND l.episode_id<?)
      ORDER BY last_listened_at DESC,l.episode_id DESC LIMIT ?`,
      )
      .bind(
        owner,
        owner,
        match ? Number(match[1]) : Number.MAX_SAFE_INTEGER,
        match ? Number(match[1]) : Number.MAX_SAFE_INTEGER,
        match?.[2] ?? "",
        limit + 1,
      )
      .all<{
        episode_id: string;
        metadata: string;
        first_listened_at: number;
        last_listened_at: number;
        listened_ms: number;
        sessions: number;
      }>();
    const page = rows.results.slice(0, limit);
    const last = page.at(-1);
    return json({
      episodes: page.map((row) => ({
        episode: JSON.parse(row.metadata),
        firstListenedAt: row.first_listened_at,
        lastListenedAt: row.last_listened_at,
        listenedMs: row.listened_ms,
        sessions: row.sessions,
      })),
      nextCursor:
        rows.results.length > limit && last
          ? `${last.last_listened_at}|${last.episode_id}`
          : null,
    });
  }

  const listeningMatch =
    /^\/api\/space\/listening\/([a-zA-Z0-9-]+)(?:\/(context))?$/.exec(path);
  if (listeningMatch) {
    const id = listeningMatch[1];
    const metadata = await episode(id);
    if (!listeningMatch[2] && method === "DELETE") {
      await db.batch([
        db
          .prepare(
            "DELETE FROM listening_events WHERE owner_id=? AND episode_id=?",
          )
          .bind(owner, id),
        db
          .prepare(
            "DELETE FROM conversations WHERE owner_id=? AND episode_id=?",
          )
          .bind(owner, id),
      ]);
      return json({ ok: true });
    }
    if (listeningMatch[2] && method === "GET") {
      const startMs = integerParam(url, "startMs", 0);
      const endMs = integerParam(
        url,
        "endMs",
        Math.min(startMs + 300_000, metadata.durationMs),
      );
      if (
        endMs <= startMs ||
        endMs > metadata.durationMs ||
        endMs - startMs > 300_000
      )
        throw new HttpError(400, "素材窗口必须在节目内，且不超过五分钟");
      const after = integerParam(url, "after", 0);
      const limit = pageSize(url);
      const spans = await db
        .prepare(
          `SELECT DISTINCT MAX(start_ms,?) AS startMs, MIN(end_ms,?) AS endMs
        FROM listening_events WHERE owner_id=? AND episode_id=? AND start_ms<? AND end_ms>?`,
        )
        .bind(startMs, endMs, owner, id, endMs, startMs)
        .all<HeardRange>();
      const heardRanges = mergeHeardRanges(spans.results);
      const analysis = (await store.episode(await store.row(id, owner)))
        .analysis;
      const passages = (analysis?.passages ?? []).flatMap((passage) => {
        const ranges = heardRanges.flatMap((range) => {
          const start = Math.max(passage.startMs, range.startMs);
          const end = Math.min(passage.endMs, range.endMs);
          return end > start ? [{ startMs: start, endMs: end }] : [];
        });
        return ranges.length
          ? [
              {
                ...passage,
                heardRanges: ranges,
                fullyHeard:
                  ranges.reduce(
                    (sum, range) => sum + range.endMs - range.startMs,
                    0,
                  ) >=
                  passage.endMs - passage.startMs,
              },
            ]
          : [];
      });
      const turns = await db
        .prepare(
          `SELECT t.ordinal,t.id,t.conversation_id,t.payload FROM conversation_turns t
        JOIN conversations c ON c.owner_id=t.owner_id AND c.id=t.conversation_id
        WHERE t.owner_id=? AND c.episode_id=? AND t.at_ms>=? AND t.at_ms<=? AND t.ordinal>?
        ORDER BY t.ordinal LIMIT ?`,
        )
        .bind(owner, id, startMs, endMs, after, limit + 1)
        .all<{
          ordinal: number;
          id: string;
          conversation_id: string;
          payload: string;
        }>();
      const page = turns.results.slice(0, limit);
      return json({
        episode: metadata,
        window: { startMs, endMs },
        heardRanges,
        passages,
        transcriptState:
          analysis?.transcript?.state ??
          (analysis ? "complete" : "unavailable"),
        turns: page.map((row) => ({
          id: row.id,
          conversationId: row.conversation_id,
          ...JSON.parse(row.payload),
        })),
        nextAfter: turns.results.length > limit ? page.at(-1)!.ordinal : null,
      });
    }
    if (!listeningMatch[2] && method === "GET") {
      const before = integerParam(url, "before", Number.MAX_SAFE_INTEGER);
      const limit = pageSize(url);
      const rows = await db
        .prepare(
          `SELECT ordinal,id,payload,received_at FROM listening_events
        WHERE owner_id=? AND episode_id=? AND ordinal<? ORDER BY ordinal DESC LIMIT ?`,
        )
        .bind(owner, id, before, limit + 1)
        .all<{
          ordinal: number;
          id: string;
          payload: string;
          received_at: number;
        }>();
      const page = rows.results.slice(0, limit);
      return json({
        episode: metadata,
        events: page.map((row) => ({
          id: row.id,
          ...JSON.parse(row.payload),
          receivedAt: row.received_at,
        })),
        nextBefore: rows.results.length > limit ? page.at(-1)!.ordinal : null,
      });
    }
  }

  if (path === "/api/space/conversations" && method === "GET") {
    const episodeId = url.searchParams.get("episodeId");
    if (episodeId) await store.row(episodeId, owner);
    const before = integerParam(url, "before", Number.MAX_SAFE_INTEGER);
    const limit = pageSize(url);
    const rows = await db
      .prepare(
        `SELECT c.* FROM conversations c JOIN episodes e ON e.id=c.episode_id
      WHERE c.owner_id=? AND e.deleted_at IS NULL AND (e.public=1 OR e.owner_id=?)
      AND (? IS NULL OR c.episode_id=?) AND c.ordinal<? ORDER BY c.ordinal DESC LIMIT ?`,
      )
      .bind(owner, owner, episodeId, episodeId, before, limit + 1)
      .all<ConversationRow>();
    const page = rows.results.slice(0, limit);
    return json({
      conversations: page.map(conversationView),
      nextBefore: rows.results.length > limit ? page.at(-1)!.ordinal : null,
    });
  }

  const conversationMatch =
    /^\/api\/space\/conversations\/([^/]+)(?:\/turns\/([^/]+))?$/.exec(path);
  if (conversationMatch) {
    const id = z.uuid().parse(conversationMatch[1]);
    const turnId = conversationMatch[2]
      ? z.uuid().parse(conversationMatch[2])
      : undefined;
    if (!turnId && method === "PUT") {
      const data = archivedConversationSchema.parse(await readJson(request));
      withinEpisode([data.atMs], await episode(data.episodeId));
      const saved = await db
        .prepare(
          `INSERT INTO conversations(owner_id,id,episode_id,at_ms,created_at)
        SELECT ?,?,?,?,? WHERE ${activeUser} AND ${accessibleEpisode}
        ON CONFLICT(owner_id,id) DO NOTHING RETURNING id`,
        )
        .bind(
          owner,
          id,
          data.episodeId,
          data.atMs,
          Date.now(),
          owner,
          data.episodeId,
          owner,
        )
        .first();
      const row = await conversation(id);
      if (row.episode_id !== data.episodeId || row.at_ms !== data.atMs)
        throw conflict();
      return json(conversationView(row), saved ? 201 : 200);
    }
    const row = await conversation(id);
    if (turnId && method === "PUT") {
      const data = archivedTurnSchema.parse(await readJson(request));
      withinEpisode(
        [
          data.atMs,
          ...data.sources.flatMap((source) =>
            source.startMs === undefined ? [] : [source.startMs],
          ),
        ],
        await episode(row.episode_id),
      );
      const payload = JSON.stringify(data);
      const saved = await db
        .prepare(
          `INSERT INTO conversation_turns
        (owner_id,conversation_id,id,sequence,at_ms,payload,received_at)
        SELECT ?,?,?,?,?,?,? WHERE ${activeUser} AND ${accessibleEpisode}
        AND EXISTS(SELECT 1 FROM conversations WHERE owner_id=? AND id=?)
        ON CONFLICT DO NOTHING RETURNING id`,
        )
        .bind(
          owner,
          id,
          turnId,
          data.sequence,
          data.atMs,
          payload,
          Date.now(),
          owner,
          row.episode_id,
          owner,
          owner,
          id,
        )
        .first();
      const existing = await db
        .prepare(
          "SELECT payload FROM conversation_turns WHERE owner_id=? AND conversation_id=? AND id=?",
        )
        .bind(owner, id, turnId)
        .first<{ payload: string }>();
      if (!existing || existing.payload !== payload) throw conflict();
      return json(
        { id: turnId, conversationId: id, ...data },
        saved ? 201 : 200,
      );
    }
    if (!turnId && method === "GET") {
      // Paginate by logical sequence, allowing a retried delivery to arrive out of order.
      const after = integerParam(url, "afterSequence", -1, 1_000_000);
      const limit = pageSize(url);
      const rows = await db
        .prepare(
          `SELECT id,sequence,payload FROM conversation_turns
        WHERE owner_id=? AND conversation_id=? AND sequence>? ORDER BY sequence LIMIT ?`,
        )
        .bind(owner, id, after, limit + 1)
        .all<{ id: string; sequence: number; payload: string }>();
      const page = rows.results.slice(0, limit);
      return json({
        conversation: conversationView(row),
        turns: page.map((turn) => ({
          id: turn.id,
          ...JSON.parse(turn.payload),
        })),
        nextAfterSequence:
          rows.results.length > limit ? page.at(-1)!.sequence : null,
      });
    }
    if (!turnId && method === "DELETE") {
      await db
        .prepare("DELETE FROM conversations WHERE owner_id=? AND id=?")
        .bind(owner, id)
        .run();
      return json({ ok: true });
    }
  }
  throw new HttpError(404, "接口不存在");
}
