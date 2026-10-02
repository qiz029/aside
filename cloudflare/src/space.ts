import type { Episode } from "@aside/engine/core";
import type { Env } from "./env.js";
import { HttpError, json } from "./http.js";
import { CloudStore, positiveLimit } from "./store.js";
import { storedAudio } from "./storage.js";

const PAGE_SIZE = 20;
const terminal = new Set(["complete", "errored", "terminated"]);

export async function cleanupStaleUploads(env: Env) {
  const stale = await env.DB.prepare(
    "SELECT id,upload_id,object_key,state FROM uploads WHERE (state='pending' AND created_at<?) OR state='rejected' LIMIT 10",
  ).bind(new Date(Date.now() - 86400000).toISOString())
    .all<{ id: string; upload_id: string; object_key: string; state: string }>();
  for (const upload of stale.results) {
    if (upload.state === "pending") {
      await env.DB.prepare("UPDATE uploads SET state='aborted' WHERE id=? AND state='pending'")
        .bind(upload.id).run();
      await env.AUDIO.resumeMultipartUpload(upload.object_key, upload.upload_id).abort().catch(() => {});
    } else {
      await env.AUDIO.delete(upload.object_key);
      await env.DB.prepare("DELETE FROM uploads WHERE id=? AND state='rejected'")
        .bind(upload.id).run();
    }
  }
}

export async function cleanupDeletedEpisode(env: Env, id: string) {
  const row = await env.DB.prepare(
    "SELECT workflow_id,deleted_at,created_at FROM episodes WHERE id=?",
  ).bind(id).first<{ workflow_id: string | null; deleted_at: number | null; created_at: string }>();
  if (!row || row.deleted_at === null) return;
  if (row.workflow_id) {
    try {
      const instance = await env.ANALYSIS.get(row.workflow_id);
      const state = await instance.status();
      if (!terminal.has(state.status)) {
        try {
          await instance.terminate();
        } catch {
          if (!terminal.has((await instance.status()).status)) throw Error("Workflow still active");
        }
      }
    } catch (error) {
      // Cloudflare no longer retains completed Workflow state after 30 days.
      if (Date.now() - Date.parse(row.created_at) < 31 * 86400000) throw error;
    }
  }
  let cursor: string | undefined;
  do {
    const page = await env.AUDIO.list({ prefix: `episodes/${id}/`, cursor });
    if (page.objects.length)
      await env.AUDIO.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM artifacts WHERE key LIKE ?").bind(`episodes/${id}/%`),
    env.DB.prepare("DELETE FROM checkpoints WHERE episode_id=?").bind(id),
    env.DB.prepare("DELETE FROM voice_usage WHERE episode_id=?").bind(id),
    env.DB.prepare("UPDATE uploads SET state='deleted' WHERE id=?").bind(id),
    env.DB.prepare("UPDATE episodes SET metadata='{}',analysis_key=NULL WHERE id=? AND deleted_at IS NOT NULL").bind(id),
  ]);
  if (Date.now() - row.deleted_at > 86400000)
    await env.DB.prepare("DELETE FROM episodes WHERE id=? AND deleted_at IS NOT NULL")
      .bind(id).run();
}

export async function spaceRoute(
  request: Request,
  env: Env,
  owner: string,
  store: CloudStore,
) {
  const url = new URL(request.url);
  if (url.pathname === "/api/space/episodes" && request.method === "GET") {
    const raw = url.searchParams.get("cursor");
    const match = raw?.match(/^(\d{4}-\d\d-\d\dT[^|]{1,40})\|([a-f0-9-]{36})$/);
    if (raw && !match) throw new HttpError(400, "无效分页位置");
    const query = match
      ? env.DB.prepare(
          `SELECT id,created_at,metadata FROM episodes
           WHERE owner_id=? AND public=0 AND deleted_at IS NULL
             AND (created_at<? OR (created_at=? AND id<?))
           ORDER BY created_at DESC,id DESC LIMIT ?`,
        ).bind(owner, match[1], match[1], match[2], PAGE_SIZE + 1)
      : env.DB.prepare(
          `SELECT id,created_at,metadata FROM episodes
           WHERE owner_id=? AND public=0 AND deleted_at IS NULL
           ORDER BY created_at DESC,id DESC LIMIT ?`,
        ).bind(owner, PAGE_SIZE + 1);
    const { results } = await query.all<{ id: string; created_at: string; metadata: string }>();
    const page = results.slice(0, PAGE_SIZE);
    const pending = await env.DB.prepare(
      "SELECT id,title,size,created_at AS createdAt FROM uploads WHERE owner_id=? AND state='pending' ORDER BY created_at DESC",
    ).bind(owner).all<{ id: string; title: string; size: number; createdAt: string }>();
    const month = new Date().toISOString().slice(0, 7);
    const usage = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM uploads WHERE owner_id=? AND substr(created_at,1,7)=? AND state NOT IN ('aborted','rejected')",
    ).bind(owner, month).first<{ count: number }>();
    const storage = await env.DB.prepare(
      `SELECT COALESCE(SUM(size),0) AS bytes FROM ${storedAudio} WHERE owner_id=?`,
    ).bind(owner).first<{ bytes: number }>();
    return json({
      episodes: page.map((row) => JSON.parse(row.metadata) as Episode),
      pending: pending.results,
      usedThisMonth: usage?.count ?? 0,
      monthlyLimit: positiveLimit(env.MONTHLY_UPLOAD_LIMIT, 100),
      usedStorage: storage?.bytes ?? 0,
      storageLimit: positiveLimit(env.ACCOUNT_STORAGE_LIMIT_BYTES, 20 * 1024 ** 3),
      nextCursor: results.length > PAGE_SIZE
        ? `${page.at(-1)!.created_at}|${page.at(-1)!.id}`
        : null,
    });
  }
  const match = /^\/api\/space\/episodes\/([a-f0-9-]{36})$/.exec(url.pathname);
  if (match && request.method === "DELETE") {
    const row = await env.DB.prepare(
      "UPDATE episodes SET deleted_at=? WHERE id=? AND owner_id=? AND public=0 AND deleted_at IS NULL RETURNING id",
    ).bind(Date.now(), match[1], owner).first();
    if (!row) throw new HttpError(404, "音频不存在");
    try {
      await cleanupDeletedEpisode(env, match[1]);
      return json({ ok: true });
    } catch {
      // The item is already hidden; scheduled cleanup retries termination and deletion.
      return json({ ok: true, cleanupPending: true }, 202);
    }
  }
  throw new HttpError(404, "接口不存在");
}
