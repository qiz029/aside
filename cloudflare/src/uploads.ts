import { z } from "zod";
import { MAX_UPLOAD_BYTES, type Episode } from "@aside/engine/core";
import type { Env } from "./env.js";
import { CloudStore, positiveLimit } from "./store.js";
import { HttpError, json, readBody, readJson } from "./http.js";
export const PART_SIZE = 8 * 1024 * 1024;
export const MAX_UPLOAD = MAX_UPLOAD_BYTES;
interface Upload {
  id: string;
  owner_id: string;
  upload_id: string;
  object_key: string;
  title: string;
  size: number;
  state: string;
  created_at: string;
}
export async function startAnalysis(
  env: Env,
  id: string,
  beforeRestart?: () => Promise<void>,
) {
  try {
    await env.ANALYSIS.create({ id, params: { episodeId: id } });
  } catch (error) {
    // Deterministic ID recovers an accepted create whose HTTP response was lost.
    const instance = await env.ANALYSIS.get(id);
    const state = await instance.status();
    if (state.status === "errored" || state.status === "terminated") {
      if (!beforeRestart) throw new HttpError(409, "分析失败，请使用重试操作");
      await beforeRestart();
      await instance.restart();
    } else if (state.status === "complete") throw error;
  }
  await env.DB.prepare("UPDATE episodes SET workflow_id=? WHERE id=?")
    .bind(id, id)
    .run();
}
export async function uploadRoute(
  request: Request,
  env: Env,
  owner: string,
  store: CloudStore,
  id?: string,
  action?: string,
) {
  if (env.ALLOW_UPLOADS !== "true" && request.method !== "DELETE")
    throw new HttpError(403, "当前仅开放示例节目试听");
  if (!env.OPENAI_API_KEY && request.method !== "DELETE")
    throw new HttpError(503, "音频分析服务尚未配置");
  if (!id && request.method === "POST") {
    const data = z
      .object({
        title: z.string().trim().min(1).max(200),
        size: z.number().int().min(44),
      })
      .parse(await readJson(request));
    if (data.size > MAX_UPLOAD) throw new HttpError(413, "文件不能超过 1 GiB");
    const createdAt = new Date().toISOString();
    const day = createdAt.slice(0, 10);
    const month = createdAt.slice(0, 7);
    const monthlyLimit = positiveLimit(env.MONTHLY_UPLOAD_LIMIT, 100);
    const globalLimit = positiveLimit(env.GLOBAL_DAILY_UPLOAD_LIMIT, 2000);
    const accountStorageLimit = positiveLimit(
      env.ACCOUNT_STORAGE_LIMIT_BYTES,
      20 * 1024 ** 3,
    );
    const globalStorageLimit = positiveLimit(
      env.GLOBAL_STORAGE_LIMIT_BYTES,
      100 * 1024 ** 3,
    );
    // Rejected or cancelled files do not occupy the account's monthly library quota,
    // but still consume R2/Container work. Cap starts independently; the
    // site-wide allowance scales with the daily upload cap so it never binds first.
    try {
      await store.reserve(`upload-init:${day}:${owner}`, 10);
      await store.reserve(`upload-init:${day}:global`, globalLimit * 3);
    } catch (error) {
      if (error instanceof HttpError && error.status === 429)
        throw new HttpError(429, "今天的上传尝试次数已用完，请明天再试");
      throw error;
    }
    id = crypto.randomUUID();
    const objectKey = `episodes/${id}/original`;
    const multipart = await env.AUDIO.createMultipartUpload(objectKey);
    try {
      const inserted = await env.DB.prepare(
        `INSERT INTO uploads(id,owner_id,upload_id,object_key,title,size,created_at)
         SELECT ?,?,?,?,?,?,?
         WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL)
           AND (SELECT COUNT(*) FROM uploads WHERE owner_id=? AND substr(created_at,1,7)=? AND state NOT IN ('aborted','rejected'))<?
           AND (SELECT COUNT(*) FROM uploads WHERE substr(created_at,1,10)=? AND state NOT IN ('aborted','rejected'))<?
           AND COALESCE((SELECT SUM(size) FROM uploads WHERE owner_id=? AND state IN ('pending','complete')),0)+?<=?
           AND COALESCE((SELECT SUM(size) FROM uploads WHERE state IN ('pending','complete')),0)+?<=?
         RETURNING id`,
      )
        .bind(
          id,
          owner,
          multipart.uploadId,
          objectKey,
          data.title,
          data.size,
          createdAt,
          owner,
          owner,
          month,
          monthlyLimit,
          day,
          globalLimit,
          owner,
          data.size,
          accountStorageLimit,
          data.size,
          globalStorageLimit,
        )
        .first<{ id: string }>();
      if (!inserted) {
        const stored = await env.DB.prepare(
          "SELECT COALESCE(SUM(size),0) AS bytes FROM uploads WHERE owner_id=? AND state IN ('pending','complete')",
        )
          .bind(owner)
          .first<{ bytes: number }>();
        const own = await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM uploads WHERE owner_id=? AND substr(created_at,1,7)=? AND state NOT IN ('aborted','rejected')",
        )
          .bind(owner, month)
          .first<{ count: number }>();
        throw new HttpError(
          429,
          (own?.count ?? 0) >= monthlyLimit
            ? `每个账号每月最多上传 ${monthlyLimit} 篇音频`
            : (stored?.bytes ?? 0) + data.size > accountStorageLimit
              ? "个人空间已达到 20 GiB 存储上限，请删除不需要的音频"
              : "今天的全站上传或存储额度已满，请稍后再试",
        );
      }
    } catch (error) {
      await multipart.abort().catch(() => {});
      throw error;
    }
    return json({ id, partSize: PART_SIZE }, 201);
  }
  const upload = await env.DB.prepare(
    "SELECT * FROM uploads WHERE id=? AND owner_id=?",
  )
    .bind(id, owner)
    .first<Upload>();
  if (!upload) throw new HttpError(404, "上传不存在");
  if (
    request.method !== "DELETE" &&
    Date.now() - Date.parse(upload.created_at) > 86400000
  )
    throw new HttpError(410, "上传已过期");
  const multipart = env.AUDIO.resumeMultipartUpload(
    upload.object_key,
    upload.upload_id,
  );
  const count = Math.ceil(upload.size / PART_SIZE);
  if (action === "part" && request.method === "PUT") {
    if (upload.state !== "pending") throw new HttpError(409, "上传已结束");
    const part = z.coerce
      .number()
      .int()
      .min(1)
      .max(count)
      .parse(new URL(request.url).searchParams.get("number"));
    const expected = Math.min(PART_SIZE, upload.size - (part - 1) * PART_SIZE);
    const bytes = await readBody(request, expected);
    if (bytes.byteLength !== expected)
      throw new HttpError(400, "分片大小不匹配");
    return json(await multipart.uploadPart(part, bytes));
  }
  if (action === "complete" && request.method === "POST") {
    const { parts } = z
      .object({
        parts: z
          .array(
            z.object({
              partNumber: z.number().int(),
              etag: z.string().min(1).max(200),
            }),
          )
          .length(count),
      })
      .parse(await readJson(request));
    if (parts.some((p, i) => p.partNumber !== i + 1))
      throw new HttpError(400, "分片顺序或数量无效");
    if (upload.state !== "pending" && upload.state !== "complete")
      throw new HttpError(409, "上传已结束");
    // R2 completion may have succeeded before a previous request disconnected.
    let object = await env.AUDIO.head(upload.object_key);
    if (!object) {
      try {
        await multipart.complete(parts);
      } catch (error) {
        if (!(await env.AUDIO.head(upload.object_key))) throw error;
      }
      object = await env.AUDIO.head(upload.object_key);
    }
    if (!object || object.size !== upload.size)
      throw new HttpError(400, "文件大小不匹配");
    const episode: Episode = {
      id: upload.id,
      title: upload.title,
      createdAt: upload.created_at,
      durationMs: 0,
      status: "queued",
      stage: "等待分析",
      progress: 0,
    };
    const claimed = await env.DB.prepare(
      "UPDATE uploads SET state='complete' WHERE id=? AND state='pending' RETURNING id",
    )
      .bind(upload.id)
      .first();
    if (!claimed) {
      const latest = await env.DB.prepare(
        "SELECT state FROM uploads WHERE id=?",
      )
        .bind(upload.id)
        .first<{ state: string }>();
      if (latest?.state !== "complete") {
        await env.AUDIO.delete(upload.object_key).catch(() => {});
        throw new HttpError(409, "上传已取消");
      }
    }
    await env.DB.prepare(
      "INSERT OR IGNORE INTO episodes(id,owner_id,metadata,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL)",
    )
      .bind(upload.id, owner, JSON.stringify(episode), upload.created_at, owner)
      .run();
    if (
      !(await env.DB.prepare(
        "SELECT id FROM users WHERE id=? AND deleted_at IS NULL",
      )
        .bind(owner)
        .first())
    ) {
      await env.AUDIO.delete(upload.object_key);
      throw new HttpError(401, "账号已删除");
    }
    const row = await store.row(upload.id, owner);
    const saved = JSON.parse(row.metadata) as Episode;
    if (["queued", "analyzing"].includes(saved.status)) {
      try {
        await startAnalysis(env, upload.id);
      } catch (error) {
        await store.update({
          ...saved,
          status: "failed",
          stage: "等待重试",
          error: "启动分析失败，请重试。",
        });
        throw error;
      }
    }
    return json(saved, 201);
  }
  if (!action && request.method === "DELETE") {
    if (upload.state !== "pending") throw new HttpError(409, "上传已结束");
    const claimed = await env.DB.prepare(
      "UPDATE uploads SET state='aborted' WHERE id=? AND state='pending' RETURNING id",
    )
      .bind(upload.id)
      .first();
    if (!claimed) throw new HttpError(409, "上传已结束");
    await multipart.abort().catch(() => {});
    return json({ ok: true });
  }
  throw new HttpError(405, "不支持的上传操作");
}
