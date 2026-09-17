import { getContainer } from "@cloudflare/containers";
import {
  authorize,
  trialRoute,
  acquire,
  release,
  budget,
  boundedHistory,
  validateWav,
} from "./trial.js";
import { z } from "zod";
import { Buffer } from "node:buffer";
import {
  checkpointSchema,
  liveSchema,
  questionSchema,
  questionEventSchema,
  questionResultSchema,
  liveControlUpdateSchema,
  type QuestionEvent,
} from "@aside/engine/contracts";
import { InteractiveProvider } from "../../backend/src/interactive-provider.js";
import {
  describeCost,
  QuestionService,
} from "../../backend/src/question-service.js";
import {
  readMicrophoneConfig,
  readVoiceLifecycleConfig,
} from "../../backend/src/config.js";
import { liveSessionPolicy } from "../../backend/src/live-session-policy.js";
import type { Env } from "./env.js";
import { session } from "./session.js";
import { CloudStore } from "./store.js";
import { HttpError, json, readBody, readJson } from "./http.js";
import { startAnalysis, uploadRoute } from "./uploads.js";
import { accountFromRequest, authRoute } from "./auth.js";
import {
  cleanupDeletedEpisode,
  cleanupStaleUploads,
  spaceRoute,
} from "./space.js";
import {
  RETENTION_DAYS,
  adminUsageRoute,
  recordQuestionUsage,
} from "./usage.js";
import { rollupDailyStats } from "./stats.js";
import { isShellRoute, seoRoute } from "./seo.js";

async function audio(request: Request, env: Env, id: string, mime: string) {
  const key = `episodes/${id}/original`;
  const head = await env.AUDIO.head(key);
  if (!head) throw new HttpError(404, "音频不存在");
  const headers = new Headers({
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    ETag: head.httpEtag,
    "Cache-Control": "private, max-age=0",
  });
  let start = 0,
    end = head.size - 1,
    partial = false;
  const range = request.headers.get("range");
  const ifRange = request.headers.get("if-range");
  if (range && (!ifRange || ifRange === head.httpEtag)) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2]))
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${head.size}` },
      });
    start = match[1]
      ? Number(match[1])
      : Math.max(0, head.size - Number(match[2]));
    end =
      match[1] && match[2]
        ? Math.min(Number(match[2]), head.size - 1)
        : head.size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start >= head.size ||
      end < start
    )
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${head.size}` },
      });
    partial = true;
    headers.set("Content-Range", `bytes ${start}-${end}/${head.size}`);
  }
  headers.set("Content-Length", String(end - start + 1));
  if (request.method === "HEAD")
    return new Response(null, { status: partial ? 206 : 200, headers });
  const object = await env.AUDIO.get(key, {
    range: { offset: start, length: end - start + 1 },
  });
  if (!object) throw new HttpError(404, "音频不存在");
  return new Response(object.body, { status: partial ? 206 : 200, headers });
}
async function route(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  owner: string,
  accountId: string | null,
) {
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method;
  const store = new CloudStore(env.DB, env.AUDIO);
  if (path === "/api/trial") return trialRoute(request, env, owner, accountId);
  if (path === "/api/health" && method === "GET")
    return json({
      ok: true,
      liveConfigured:
        !!env.OPENAI_API_KEY &&
        !!env.TURNSTILE_SITE_KEY &&
        !!env.TURNSTILE_SECRET_KEY &&
        env.AI_ENABLED !== "false",
      trial: true,
      model: "gpt-live-1",
      microphone: { ...readMicrophoneConfig({}), maxCaptureMs: 30000 },
      voiceLifecycle: readVoiceLifecycleConfig({}),
      uploadMode: "multipart",
      uploadsEnabled: env.ALLOW_UPLOADS === "true",
    });
  if (path === "/api/episodes" && method === "GET")
    return json(await store.list(owner));
  if (path.startsWith("/api/space/")) {
    if (!accountId) throw new HttpError(401, "请先登录");
    return spaceRoute(request, env, accountId, store);
  }
  if (path === "/api/episodes" && method === "POST")
    throw new HttpError(400, "云端上传请使用分片上传接口");
  const upload =
    /^\/api\/uploads(?:\/([a-f0-9-]+)(?:\/(part|complete))?)?$/.exec(path);
  if (upload) {
    if (!accountId) throw new HttpError(401, "请先登录再上传音频");
    if (request.method === "POST" && (!upload[1] || upload[2] === "complete"))
      await authorize(request, env, owner, accountId);
    return uploadRoute(request, env, owner, store, upload[1], upload[2]);
  }
  const match = /^\/api\/episodes\/([a-zA-Z0-9-]+)(?:\/([a-z-]+))?$/.exec(path);
  if (!match) throw new HttpError(404, "接口不存在");
  const [, id, action] = match;
  const row = await store.row(id, owner);
  const metadata = JSON.parse(row.metadata);
  if (!action && method === "GET") return json(await store.episode(row));
  if (action === "audio" && ["GET", "HEAD"].includes(method)) {
    if (
      row.public !== 1 &&
      (metadata.durationMs <= 0 || metadata.status === "blocked")
    )
      throw new HttpError(409, "音频仍在检查中或未通过检查");
    return audio(request, env, id, metadata.mimeType ?? "audio/mpeg");
  }
  if (action === "cover" && method === "GET") {
    const object = metadata.cover
      ? await env.AUDIO.get(`episodes/${id}/cover.jpg`)
      : null;
    if (!object) throw new HttpError(404, "封面不存在");
    return new Response(object.body, {
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": String(object.size),
      },
    });
  }
  if (action === "checkpoint") {
    if (method === "GET") {
      const result = await env.DB.prepare(
        "SELECT value,version FROM checkpoints WHERE owner_id=? AND episode_id=?",
      )
        .bind(owner, id)
        .first<{ value: string; version: number }>();
      return json(
        result
          ? { ...JSON.parse(result.value), version: result.version }
          : null,
      );
    }
    if (method === "PUT") {
      const value = checkpointSchema.parse(await readJson(request));
      value.positionMs = Math.min(value.positionMs, metadata.durationMs);
      if (value.resumeMs !== undefined)
        value.resumeMs = Math.min(value.resumeMs, metadata.durationMs);
      const expected = value.version ?? 0;
      const saved = await env.DB.prepare(
        "INSERT INTO checkpoints(owner_id,episode_id,value,version) SELECT ?,?,?,1 WHERE ?=0 OR EXISTS(SELECT 1 FROM checkpoints WHERE owner_id=? AND episode_id=? AND version=?) ON CONFLICT(owner_id,episode_id) DO UPDATE SET value=excluded.value,version=checkpoints.version+1 WHERE checkpoints.version=? RETURNING version",
      )
        .bind(
          owner,
          id,
          JSON.stringify(value),
          expected,
          owner,
          id,
          expected,
          expected,
        )
        .first<{ version: number }>();
      if (!saved)
        return json(
          { error: "其他设备已更新收听进度", code: "checkpoint_conflict" },
          409,
        );
      return json({ ...value, version: saved.version });
    }
  }
  if (action === "retry" && method === "POST") {
    if (!accountId) throw new HttpError(401, "请先登录");
    await authorize(request, env, owner, accountId);
    if (row.owner_id !== owner) throw new HttpError(403, "只能重试自己的节目");
    if (!["failed", "queued", "analyzing"].includes(metadata.status))
      throw new HttpError(409, "当前任务不能重试");
    if (!env.OPENAI_API_KEY) throw new HttpError(503, "分析服务尚未配置");
    await startAnalysis(env, id, async () => {
      const day = new Date().toISOString().slice(0, 10);
      await store.reserve(`analysis-retry:${day}:${owner}`, 2);
      await store.reserve(`analysis-retry:${day}:global`, 10);
    });
    return json(metadata);
  }
  if (action === "usage") {
    if (method === "GET")
      return json(
        (
          await env.DB.prepare(
            "SELECT session_id AS sessionId,seconds,finalized FROM voice_usage WHERE owner_id=? AND episode_id=?",
          )
            .bind(owner, id)
            .all()
        ).results,
      );
    if (method === "POST") {
      const data = z
        .object({
          sessionId: z.string().min(1).max(200),
          seconds: z.number().finite().min(0).max(86400),
          finalized: z.boolean(),
          closed: z.boolean().optional(),
        })
        .parse(await readJson(request));
      const result = await env.DB.prepare(
        "UPDATE voice_usage SET seconds=MAX(seconds,?) WHERE session_id=? AND owner_id=? AND episode_id=? RETURNING session_id",
      )
        .bind(
          Math.min(data.seconds, liveSessionPolicy(env, !!accountId).seconds),
          data.sessionId,
          owner,
          id,
        )
        .first();
      if (!result) throw new HttpError(404, "语音会话不存在");
      if (data.finalized || data.closed)
        await env.LIVE.get(env.LIVE.idFromName(owner)).close(data.sessionId);
      return json({ ok: true });
    }
  }
  if (action === "live-control" && ["GET", "PUT"].includes(method)) {
    const data =
      method === "PUT"
        ? liveControlUpdateSchema.parse(await readJson(request))
        : undefined;
    const sessionId = data?.sessionId ?? url.searchParams.get("sessionId");
    if (!sessionId || sessionId.length > 200)
      throw new HttpError(400, "Invalid voice session");
    const target = new URL("https://live/control");
    target.searchParams.set("sessionId", sessionId);
    target.searchParams.set("episode", id);
    // This is an existing authenticated Live lease, not a billable request per
    // fragment. Updates carry playback state and execution acknowledgements,
    // never browser-selected speech or intent decisions.
    return env.LIVE.get(env.LIVE.idFromName(owner)).fetch(
      new Request(target, {
        method,
        ...(data
          ? {
              body: JSON.stringify(data),
              headers: { "Content-Type": "application/json" },
            }
          : {}),
      }),
    );
  }
  if (
    method !== "POST" ||
    !["question", "live", "transcribe-question"].includes(action)
  )
    throw new HttpError(404, "接口不存在");
  if (!env.OPENAI_API_KEY) throw new HttpError(503, "语音与问答服务尚未配置");
  await authorize(request, env, owner, accountId);
  const provider = new InteractiveProvider(
    env.OPENAI_API_KEY,
    env.ASIDE_BACKEND_MODEL,
    true,
  );
  if (action === "transcribe-question") {
    const bytes = await readBody(request, 12 * 1024 * 1024 + 4096);
    let form: FormData;
    try {
      form = await new Response(bytes, {
        headers: { "Content-Type": request.headers.get("content-type") ?? "" },
      }).formData();
    } catch {
      throw new HttpError(400, "缺少问题录音");
    }
    const file = form.get("audio");
    if (!file || typeof file === "string" || file.size > 12 * 1024 * 1024)
      throw new HttpError(400, "无效问题录音");
    let wav = Buffer.from(await file.arrayBuffer());
    const m4a = ["audio/mp4", "audio/m4a", "audio/x-m4a"].includes(file.type);
    if (m4a) {
      if (!accountId) throw new HttpError(401, "请先登录");
      if (env.MOBILE_AUDIO_ENABLED !== "true")
        throw new HttpError(503, "手机语音服务尚未启用");
      if (file.size > 2 * 1024 * 1024)
        throw new HttpError(413, "问题录音超过 2 MiB");
    } else validateWav(wav);
    const token = await acquire(env, owner, "operation");
    try {
      await budget(env, owner, "transcribe", request);
      if (m4a) {
        const response = await getContainer(
          env.MEDIA,
          "mobile-questions",
        ).fetch(
          new Request("http://media/question", {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: wav,
            signal: AbortSignal.timeout(30000),
          }),
        );
        if (!response.ok)
          throw new HttpError(
            response.status === 422 ? 400 : 503,
            "录音无法处理，请重试",
          );
        const converted = await readBody(
          new Request("http://media/result", {
            method: "POST",
            body: response.body,
          }),
          3 * 1024 * 1024,
        );
        wav = Buffer.from(converted);
        validateWav(wav);
      }
      return json({
        text: await provider.transcribeQuestion(
          wav,
          AbortSignal.any([request.signal, AbortSignal.timeout(30000)]),
        ),
      });
    } finally {
      await release(env, owner, "operation", token);
    }
  }
  const episode = await store.episode(row);
  if (!episode.analysis) throw new HttpError(409, "节目尚未完成分析");
  if (action === "live") {
    const data = liveSchema.parse(await readJson(request));
    boundedHistory(data.history);
    // Validate operator configuration before reserving a live lease.
    liveSessionPolicy(env, !!accountId);
    const token = await acquire(env, owner, "live");
    try {
      await budget(env, owner, "live", request);
      if (data.control) await budget(env, owner, "question", request);
    } catch (error) {
      await release(env, owner, "live", token);
      throw error;
    }
    // Once dispatched, only the supervisor can release the lease: network failure is ambiguous.
    return json(
      await env.LIVE.get(env.LIVE.idFromName(owner)).start(
        owner,
        token,
        id,
        data.sdp,
        episode.analysis,
        Math.min(data.atMs, episode.durationMs),
        data.history,
        data.control,
        accountId,
      ),
    );
  }
  const data = questionSchema.parse(await readJson(request));
  data.atMs = Math.min(data.atMs, episode.durationMs);
  boundedHistory(data.history);
  const token = await acquire(env, owner, "operation");
  try {
    await budget(env, owner, "question", request);
  } catch (error) {
    await release(env, owner, "operation", token);
    throw error;
  }
  const questions = new QuestionService(provider, 3);
  // Workers Logs is the only sink here: a downgrade to standard speed shows up
  // as tier=default, and the token counts are what fast mode's premium applies to.
  const cost = (totals: Parameters<typeof describeCost>[0]) => {
    console.log(`question ${id} ${describeCost(totals)}`);
    ctx.waitUntil(
      recordQuestionUsage(env, {
        owner,
        accountId,
        episodeId: id,
        totals,
      }),
    );
  };
  const abort = new AbortController();
  const signal = AbortSignal.any([
    request.signal,
    abort.signal,
    AbortSignal.timeout(60000),
  ]);
  if (!request.headers.get("accept")?.includes("application/x-ndjson")) {
    try {
      return json(
        questionResultSchema.parse(
          await questions.answer(
            episode.analysis,
            data,
            signal,
            undefined,
            cost,
          ),
        ),
      );
    } finally {
      await release(env, owner, "operation", token);
    }
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: QuestionEvent) => {
        if (!signal.aborted)
          controller.enqueue(
            encoder.encode(
              JSON.stringify(questionEventSchema.parse(event)) + "\n",
            ),
          );
      };
      ctx.waitUntil(
        (async () => {
          try {
            const result = questionResultSchema.parse(
              await questions.answer(
                episode.analysis!,
                data,
                signal,
                (phase) =>
                  emit({ type: "progress", revision: data.revision, phase }),
                cost,
                request.headers.get("X-Aside-Answer-Stream") === "1"
                  ? (text) =>
                      emit({ type: "answer", revision: data.revision, text })
                  : undefined,
              ),
            );
            emit({ type: "result", result });
          } catch (error) {
            // The cause stays in the Worker log; the listener sees a safe message.
            console.error("Aside question failed", {
              episode: id,
              reason: error instanceof Error ? error.message : String(error),
              aborted: signal.aborted,
              timedOut:
                signal.aborted &&
                !request.signal.aborted &&
                !abort.signal.aborted,
            });
            if (!signal.aborted)
              emit({ type: "error", error: "回答失败，请重试" });
          } finally {
            await release(env, owner, "operation", token);
            if (!abort.signal.aborted) controller.close();
          }
        })(),
      );
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
    },
  });
}
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/api/")) {
      try {
        const seo = await seoRoute(request, env);
        if (seo) return seo;
      } catch {
        // The search-engine surface must never take the app down. Shell routes
        // have no static file of their own, so hand back the root document;
        // anything else keeps its honest answer from the asset binding.
        return isShellRoute(path)
          ? env.ASSETS.fetch(new URL("/", request.url).toString())
          : env.ASSETS.fetch(request);
      }
      return env.ASSETS.fetch(request);
    }
    try {
      // Before session/account work: an operator CLI is not a listener and must
      // not be issued a trial identity or a cookie.
      if (path === "/api/admin/usage") {
        const result = await adminUsageRoute(request, env);
        result.headers.set("Cache-Control", "no-store");
        return result;
      }
      const origin = request.headers.get("origin");
      const bearer = request.headers.get("authorization");
      const account = await accountFromRequest(request, env);
      if (bearer && !account)
        throw new HttpError(401, "登录已过期，请重新登录");
      const mobileLogin = /^\/api\/auth\/mobile\/email\/(start|verify)$/.test(
        path,
      );
      const googleCallback =
        path === "/api/auth/google/callback" && request.method === "GET";
      if (origin && origin !== env.APP_ORIGIN)
        throw new HttpError(403, "Unexpected origin");
      if (
        !googleCallback &&
        request.headers.get("sec-fetch-site") === "cross-site"
      )
        throw new HttpError(403, "Cross-site request rejected");
      // Mutations require the browser origin, while CLI clients must explicitly supply it.
      if (
        !["GET", "HEAD"].includes(request.method) &&
        origin !== env.APP_ORIGIN &&
        !(bearer && account) &&
        !mobileLogin
      )
        throw new HttpError(403, "Origin required");
      const identity = await session(request, env.SESSION_SECRET);
      const result =
        path.startsWith("/api/auth/") || path.startsWith("/api/profile")
          ? await authRoute(request, env, identity.id, account)
          : await route(
              request,
              env,
              ctx,
              account?.id ?? identity.id,
              account?.id ?? null,
            );
      const response = new Response(result.body, result);
      response.headers.set("Cache-Control", "no-store");
      if (identity.cookie)
        response.headers.append("Set-Cookie", identity.cookie);
      return response;
    } catch (error) {
      if (error instanceof HttpError)
        return json({ error: error.message, code: error.code }, error.status);
      if (error instanceof z.ZodError)
        return json({ error: "请求格式无效" }, 400);
      // Never expose SDK headers, keys, transcripts or internal exception messages.
      console.error("Aside API request failed", {
        path: new URL(request.url).pathname,
      });
      return json({ error: "服务暂时不可用，请重试" }, 503);
    }
  },
  async scheduled(_event: ScheduledController, env: Env) {
    const cutoff = new Date(Date.now() - 2 * 86400000)
      .toISOString()
      .slice(0, 10);
    // Before the cleanup below: it deletes the trial counters this reads.
    await rollupDailyStats(env);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM trial_proofs WHERE expires<?").bind(
        Date.now(),
      ),
      env.DB.prepare("DELETE FROM question_usage WHERE ts<?").bind(
        Date.now() - RETENTION_DAYS * 86400000,
      ),
      env.DB.prepare(
        "DELETE FROM budgets WHERE bucket LIKE 'burst:%' AND CAST(substr(bucket,7,instr(substr(bucket,7),':')-1) AS INTEGER)<?",
      ).bind(Math.floor(Date.now() / 60000) - 5),
      env.DB.prepare(
        "DELETE FROM budgets WHERE bucket LIKE 'trial:%' AND substr(bucket,7,10)<?",
      ).bind(cutoff),
      env.DB.prepare(
        "DELETE FROM trial_leases WHERE kind!='live' AND expires<?",
      ).bind(Date.now()),
      env.DB.prepare("DELETE FROM auth_sessions WHERE expires<?").bind(
        Date.now(),
      ),
      env.DB.prepare("DELETE FROM auth_codes WHERE expires<?").bind(Date.now()),
      env.DB.prepare("DELETE FROM auth_oauth_states WHERE expires<?").bind(
        Date.now(),
      ),
      env.DB.prepare(
        "DELETE FROM budgets WHERE bucket LIKE 'auth:%' AND CAST(substr(bucket,6,10) AS INTEGER)<?",
      ).bind(Math.floor(Date.now() / 3600000) - 2),
      env.DB.prepare(
        "DELETE FROM budgets WHERE bucket LIKE 'upload-init:%' AND substr(bucket,13,10)<?",
      ).bind(cutoff),
    ]);
    await cleanupStaleUploads(env);
    const deleted = await env.DB.prepare(
      "SELECT id FROM episodes WHERE deleted_at IS NOT NULL LIMIT 10",
    ).all<{ id: string }>();
    for (const row of deleted.results) {
      await cleanupDeletedEpisode(env, row.id).catch(() => {});
    }
  },
} satisfies ExportedHandler<Env>;
