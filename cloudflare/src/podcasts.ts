import { z } from "zod";
import type {
  PodcastShowPage,
  PodcastSubscriptions,
} from "@aside/engine/contracts";
import {
  lookupPodcast,
  readPodcastFeed,
  searchPodcasts,
  catalogEpisode,
  podcastSelectionSchema,
  podcastCountrySchema,
} from "../../backend/src/podcast-catalog.js";
import type { Env } from "./env.js";
import { CloudStore } from "./store.js";
import { HttpError, json, readJson } from "./http.js";

const countrySchema = podcastCountrySchema;
export { podcastSelectionSchema };
const TTL = 60 * 60 * 1000;
interface Row {
  id: string;
  show_json: string;
  episodes_json: string;
  checked_at: number;
  attempted_at: number;
  refresh_error: number;
}
function page(row: Row): PodcastShowPage {
  return {
    show: JSON.parse(row.show_json),
    episodes: JSON.parse(row.episodes_json),
    checkedAt: row.checked_at,
    stale: !!row.refresh_error || Date.now() - row.checked_at > TTL,
  };
}
async function directoryBudget(env: Env) {
  await new CloudStore(env.DB, env.AUDIO).reserve(
    `burst:${Math.floor(Date.now() / 60000)}:podcast-directory`,
    18,
  );
}
async function refresh(env: Env, row: Row): Promise<Row> {
  const now = Date.now();
  const claimed = await env.DB.prepare(
    "UPDATE podcast_catalog SET attempted_at=? WHERE id=? AND attempted_at=?",
  )
    .bind(now, row.id, row.attempted_at)
    .run();
  if (!claimed.meta.changes) return row;
  try {
    const episodes = await readPodcastFeed(JSON.parse(row.show_json));
    const updated = {
      ...row,
      episodes_json: JSON.stringify(episodes),
      checked_at: now,
      attempted_at: now,
      refresh_error: 0,
    };
    await env.DB.prepare(
      "UPDATE podcast_catalog SET episodes_json=?,checked_at=?,refresh_error=0 WHERE id=? AND attempted_at=?",
    )
      .bind(updated.episodes_json, now, row.id, now)
      .run();
    return updated;
  } catch (error) {
    await env.DB.prepare(
      "UPDATE podcast_catalog SET refresh_error=1 WHERE id=? AND attempted_at=?",
    )
      .bind(row.id, now)
      .run();
    if (!row.checked_at) throw error;
    return { ...row, refresh_error: 1 };
  }
}
export async function getPodcast(
  env: Env,
  id: string,
  country: string,
  preferCached = false,
): Promise<PodcastShowPage> {
  let row = await env.DB.prepare("SELECT * FROM podcast_catalog WHERE id=?")
    .bind(id)
    .first<Row>();
  if (!row) {
    await directoryBudget(env);
    const show = await lookupPodcast(id, country);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO podcast_catalog(id,show_json) VALUES(?,?)",
    )
      .bind(id, JSON.stringify(show))
      .run();
    row = (await env.DB.prepare("SELECT * FROM podcast_catalog WHERE id=?")
      .bind(id)
      .first<Row>())!;
  }
  if (preferCached && row.checked_at) return page(row);
  if (
    Date.now() - row.checked_at > TTL &&
    Date.now() - row.attempted_at > 60000
  )
    row = await refresh(env, row);
  if (!row.checked_at)
    throw new HttpError(
      503,
      "节目正在更新，请稍后重试 / Podcast is updating; try again shortly",
    );
  return page(row);
}
export async function selectedPodcast(
  env: Env,
  selection: { showId: string; country: string; guid: string },
) {
  const result = await getPodcast(
    env,
    selection.showId,
    selection.country,
    true,
  );
  const item = result.episodes.find((item) => item.guid === selection.guid);
  if (!item)
    throw new HttpError(
      404,
      "单集已不在节目列表中，请刷新 / Episode unavailable; refresh the show",
    );
  return { episode: catalogEpisode(result.show, item), positionMs: 0 };
}
export async function refreshSubscriptions(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT * FROM podcast_catalog c WHERE checked_at<? AND attempted_at<?
    AND EXISTS(SELECT 1 FROM podcast_subscriptions s WHERE s.show_id=c.id) ORDER BY attempted_at LIMIT 10`,
  )
    .bind(Date.now() - TTL, Date.now() - TTL)
    .all<Row>();
  // Bound outbound feed work; never download audio or start analysis here.
  for (let i = 0; i < rows.results.length; i += 2)
    await Promise.allSettled(
      rows.results.slice(i, i + 2).map((row) => refresh(env, row)),
    );
  await env.DB.prepare(
    "DELETE FROM podcast_catalog WHERE checked_at<? AND attempted_at<? AND NOT EXISTS(SELECT 1 FROM podcast_subscriptions s WHERE s.show_id=podcast_catalog.id)",
  )
    .bind(Date.now() - 7 * 86400000, Date.now() - 7 * 86400000)
    .run();
  await env.DB.prepare("DELETE FROM podcast_search_cache WHERE checked_at<?")
    .bind(Date.now() - 86400000)
    .run();
}
export async function podcastRoute(
  request: Request,
  env: Env,
  accountId: string | null,
) {
  const url = new URL(request.url),
    path = url.pathname;
  const country = countrySchema.parse(url.searchParams.get("country") ?? "US");
  if (path === "/api/podcasts/search" && request.method === "GET") {
    const query = z
      .string()
      .trim()
      .min(2)
      .max(120)
      .parse(url.searchParams.get("q"));
    const cached = await env.DB.prepare(
      "SELECT results_json FROM podcast_search_cache WHERE query=? AND country=? AND checked_at>?",
    )
      .bind(query.toLowerCase(), country, Date.now() - TTL)
      .first<{ results_json: string }>();
    if (cached) return json({ shows: JSON.parse(cached.results_json) });
    await directoryBudget(env);
    const shows = await searchPodcasts(query, country);
    await env.DB.prepare(
      "INSERT OR REPLACE INTO podcast_search_cache(query,country,results_json,checked_at) VALUES(?,?,?,?)",
    )
      .bind(query.toLowerCase(), country, JSON.stringify(shows), Date.now())
      .run();
    return json({ shows });
  }
  const show = /^\/api\/podcasts\/shows\/(\d{1,20})$/.exec(path);
  if (show && request.method === "GET")
    return json(await getPodcast(env, show[1], country));
  if (path.startsWith("/api/podcasts/subscriptions")) {
    if (!accountId) throw new HttpError(401, "请先登录 / Sign in first");
    if (path === "/api/podcasts/subscriptions" && request.method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT c.*,s.created_at FROM podcast_subscriptions s JOIN podcast_catalog c ON c.id=s.show_id WHERE s.owner_id=? ORDER BY s.created_at DESC",
      )
        .bind(accountId)
        .all<Row & { created_at: number }>();
      const result: PodcastSubscriptions = { subscriptions: [], episodes: [] };
      for (const row of rows.results) {
        const value = page(row);
        result.subscriptions.push({
          show: value.show,
          subscribedAt: row.created_at,
          checkedAt: value.checkedAt,
          stale: value.stale,
        });
        result.episodes.push(
          ...value.episodes.map((episode) => ({ show: value.show, episode })),
        );
      }
      result.episodes.sort((a, b) =>
        (b.episode.publishedAt ?? "").localeCompare(
          a.episode.publishedAt ?? "",
        ),
      );
      result.episodes = result.episodes.slice(0, 50);
      return json(result);
    }
    const target = /^\/api\/podcasts\/subscriptions\/(\d{1,20})$/.exec(path);
    if (target && request.method === "DELETE") {
      await env.DB.prepare(
        "DELETE FROM podcast_subscriptions WHERE owner_id=? AND show_id=?",
      )
        .bind(accountId, target[1])
        .run();
      return json({ ok: true });
    }
    if (target && request.method === "PUT") {
      const body = z
        .object({ country: countrySchema.default("US") })
        .parse(await readJson(request));
      const existing = await env.DB.prepare(
        "SELECT 1 FROM podcast_subscriptions WHERE owner_id=? AND show_id=?",
      )
        .bind(accountId, target[1])
        .first();
      if (existing) return json({ ok: true });
      await getPodcast(env, target[1], body.country);
      const added = await env.DB.prepare(
        `INSERT OR IGNORE INTO podcast_subscriptions(owner_id,show_id,created_at)
        SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL)
        AND (SELECT COUNT(*) FROM podcast_subscriptions WHERE owner_id=?)<100`,
      )
        .bind(accountId, target[1], Date.now(), accountId, accountId)
        .run();
      if (!added.meta.changes)
        throw new HttpError(
          409,
          "订阅未添加，请检查登录状态或订阅数量（最多 100 个） / Subscription not added; check your account or the 100-show limit",
        );
      return json({ ok: true }, 201);
    }
  }
  throw new HttpError(404, "接口不存在");
}
