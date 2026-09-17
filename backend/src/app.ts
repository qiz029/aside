import { PassThrough, Readable } from "node:stream";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { z } from "zod";
import type { Episode } from "@aside/engine/core";
import { questionSchema, liveSchema, checkpointSchema } from "./contracts.js";
import { Store } from "./store.js";
import type { BackendServices } from "./services.js";
import {
  questionEventSchema,
  questionResultSchema,
  type QuestionEvent,
  liveControlUpdateSchema,
} from "@aside/engine/contracts";
import { Jobs } from "./jobs.js";
import { describeCost, type QuestionTelemetry } from "./question-service.js";
import { withMedia } from "./local-media.js";
import { readMicrophoneConfig, readVoiceLifecycleConfig } from "./config.js";
import { LiveControl } from "./live-control.js";
import {
  liveSessionExpired,
  liveSessionPolicy,
} from "./live-session-policy.js";
import type { LiveSideband } from "./live-sideband.js";
export function createApp(store: Store, services?: BackendServices) {
  const microphone = readMicrophoneConfig();
  const voiceLifecycle = readVoiceLifecycleConfig();
  const sessionPolicy = liveSessionPolicy(process.env, true);
  const app = Fastify({ logger: false, bodyLimit: 256000 });
  const jobs = new Jobs(store, services?.analysis);
  const controls = new Map<
    string,
    {
      episode: string;
      control: LiveControl;
      socket?: LiveSideband;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const closeControl = (id: string, error?: string) => {
    const entry = controls.get(id);
    if (!entry) return;
    controls.delete(id);
    clearTimeout(entry.timer);
    entry.control.close(error);
    entry.socket?.close();
  };
  app.addHook("onClose", async () => {
    for (const id of controls.keys()) closeControl(id);
  });
  app.register(multipart, {
    limits: { fileSize: 500 * 1024 * 1024, files: 1, parts: 2 },
  });
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (
      origin &&
      ![
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:4310",
        "http://localhost:4310",
      ].includes(origin)
    )
      return reply.code(403).send({ error: "Unexpected origin" });
  });
  app.setErrorHandler((error, _req, reply) => {
    reply.code(error instanceof z.ZodError ? 400 : 400).send({
      error: error instanceof Error ? error.message : "Request failed",
    });
  });
  const get = (id: string) => {
    const e = store.get(id);
    if (!e) throw Error("节目不存在");
    return e;
  };
  app.get("/api/health", async () => ({
    ok: true,
    liveConfigured: !!services,
    model: "gpt-live-1",
    microphone,
    voiceLifecycle,
  }));
  app.get("/api/episodes", async () =>
    store
      .list()
      .map(({ analysis, ...e }) => ({ ...e, voice: analysis?.voice })),
  );
  app.get<{ Params: { id: string } }>("/api/episodes/:id", async (req) =>
    get(req.params.id),
  );
  app.post("/api/episodes", async (req, reply) => {
    const file = await req.file();
    if (!file) throw Error("请选择音频文件");
    const id = crypto.randomUUID();
    const key = `episodes/${id}/original`;
    const coverKey = `episodes/${id}/cover.jpg`;
    try {
      await store.objects.put(key, file.file);
      if (file.file.truncated) throw Error("音频超过 500 MB");
      const { durationMs, mimeType, cover } = await withMedia(
        store.objects,
        key,
        async (media) => ({
          ...(await media.probe()),
          cover: await media.cover(),
        }),
      );
      if (cover) await store.objects.put(coverKey, [cover]);
      const e: Episode = {
        id,
        title: file.filename.replace(/\.[^.]+$/, "").slice(0, 200),
        createdAt: new Date().toISOString(),
        durationMs,
        mimeType,
        ...(cover ? { cover: true } : {}),
        status: "queued",
        stage: "等待分析",
        progress: 0,
      };
      store.put(e);
      void jobs.drain();
      return reply.code(201).send(e);
    } catch (err) {
      store.objects.delete(key);
      store.objects.delete(coverKey);
      throw err;
    }
  });
  app.post<{ Params: { id: string } }>(
    "/api/episodes/:id/retry",
    async (req) => {
      const e = get(req.params.id);
      if (!["failed", "blocked"].includes(e.status))
        throw Error("当前任务不能重试");
      e.status = "queued";
      delete e.error;
      store.put(e);
      void jobs.drain();
      return e;
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/episodes/:id/audio",
    async (req, reply) => {
      const episode = get(req.params.id);
      const key = `episodes/${req.params.id}/original`;
      const object = store.objects.head(key);
      if (!object) throw Error("音频不存在");
      const { size } = object;
      reply
        .header("Accept-Ranges", "bytes")
        .type(episode.mimeType ?? "audio/mpeg");
      const range = req.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2]))
          return reply
            .code(416)
            .header("Content-Range", `bytes */${size}`)
            .send();
        let start = match[1]
          ? Number(match[1])
          : Math.max(0, size - Number(match[2]));
        let end = match[1]
          ? match[2]
            ? Math.min(Number(match[2]), size - 1)
            : size - 1
          : size - 1;
        if (start >= size || end < start)
          return reply
            .code(416)
            .header("Content-Range", `bytes */${size}`)
            .send();
        return reply
          .code(206)
          .header("Content-Range", `bytes ${start}-${end}/${size}`)
          .header("Content-Length", end - start + 1)
          .send(Readable.from(store.objects.read(key, start, end)));
      }
      return reply
        .header("Content-Length", size)
        .send(Readable.from(store.objects.read(key)));
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/episodes/:id/cover",
    async (req, reply) => {
      get(req.params.id);
      const key = `episodes/${req.params.id}/cover.jpg`;
      const object = store.objects.head(key);
      if (!object) return reply.code(404).send({ error: "封面不存在" });
      return reply
        .type("image/jpeg")
        .header("Content-Length", object.size)
        .send(Readable.from(store.objects.read(key)));
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/episodes/:id/checkpoint",
    async (req) => {
      get(req.params.id);
      return store.checkpoint(req.params.id);
    },
  );
  app.put<{ Params: { id: string } }>(
    "/api/episodes/:id/checkpoint",
    async (req, reply) => {
      const e = get(req.params.id);
      const data = checkpointSchema.parse(req.body);
      data.positionMs = Math.min(data.positionMs, e.durationMs);
      if (data.resumeMs !== undefined)
        data.resumeMs = Math.min(data.resumeMs, e.durationMs);
      const current = store.checkpoint(req.params.id) as {
        version?: number;
      } | null;
      if ((data.version ?? 0) !== (current?.version ?? 0))
        return reply.code(409).send({
          error: "其他设备已更新收听进度",
          code: "checkpoint_conflict",
        });
      return store.checkpoint(req.params.id, {
        ...data,
        version: (current?.version ?? 0) + 1,
      });
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/episodes/:id/question",
    async (req, reply) => {
      const e = get(req.params.id);
      if (!e.analysis) throw Error("节目尚未完成分析");
      if (!services)
        return reply
          .code(503)
          .send({ error: "请在本地 .env 配置 OPENAI_API_KEY 后重启后端" });
      const q = questionSchema.parse(req.body);
      const controller = new AbortController();
      req.raw.on("aborted", () => controller.abort());
      const onClose = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      reply.raw.on("close", onClose);
      const taskId = `question-${crypto.randomUUID()}`;
      store.saveArtifact(e.id, taskId, {
        status: "running",
        revision: q.revision,
        history: q.history,
        atMs: q.atMs,
      });
      const streaming = req.headers.accept?.includes("application/x-ndjson");
      const stream = streaming ? new PassThrough() : undefined;
      const send = (event: QuestionEvent) => {
        if (stream && !stream.destroyed && !controller.signal.aborted)
          stream.write(JSON.stringify(questionEventSchema.parse(event)) + "\n");
      };
      if (stream)
        reply
          .header("Content-Type", "application/x-ndjson")
          .header("Cache-Control", "no-cache")
          .send(stream);
      // Kept outside the try so a failed question still records what it spent.
      let cost: QuestionTelemetry | undefined;
      try {
        const result = questionResultSchema.parse(
          await services.questions.answer(
            e.analysis,
            { ...q, atMs: Math.min(q.atMs, e.durationMs) },
            AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]),
            (phase) => send({ type: "progress", revision: q.revision, phase }),
            (totals) => {
              cost = totals;
              console.log(`question ${taskId} ${describeCost(totals)}`);
            },
            req.headers["x-aside-answer-stream"] === "1"
              ? (text) => send({ type: "answer", revision: q.revision, text })
              : undefined,
          ),
        );
        store.saveArtifact(e.id, taskId, {
          status: controller.signal.aborted ? "superseded" : "completed",
          ...result,
          ...(cost ? { cost } : {}),
        });
        if (stream) {
          send({ type: "result", result });
          stream.end();
          return reply;
        }
        return result;
      } catch (error) {
        store.saveArtifact(e.id, taskId, {
          status: controller.signal.aborted ? "superseded" : "failed",
          revision: q.revision,
          ...(cost ? { cost } : {}),
        });
        if (stream) {
          send({
            type: "error",
            error: error instanceof Error ? error.message : "Question failed",
          });
          stream.end();
          return reply;
        }
        throw error;
      } finally {
        reply.raw.off("close", onClose);
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/episodes/:id/transcribe-question",
    async (req, reply) => {
      get(req.params.id);
      if (!services)
        return reply.code(503).send({ error: "服务端未配置 OpenAI API key" });
      const file = await req.file({
        limits: { fileSize: 12 * 1024 * 1024, files: 1 },
      });
      if (!file) throw Error("缺少问题录音");
      const bytes = await file.toBuffer();
      if (
        bytes.length < 44 ||
        bytes.toString("ascii", 0, 4) !== "RIFF" ||
        bytes.toString("ascii", 8, 12) !== "WAVE"
      )
        throw Error("问题录音必须为 WAV");
      const abort = new AbortController();
      const onClose = () => {
        if (!reply.raw.writableEnded) abort.abort();
      };
      reply.raw.on("close", onClose);
      try {
        return {
          text: await services.voice.transcribeQuestion(
            bytes,
            AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]),
          ),
        };
      } finally {
        reply.raw.off("close", onClose);
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/episodes/:id/live",
    async (req, reply) => {
      const e = get(req.params.id);
      if (!e.analysis) throw Error("节目尚未完成分析");
      if (!services)
        return reply.code(503).send({ error: "服务端未配置 OpenAI API key" });
      const q = liveSchema.parse(req.body);
      if (q.control && !services.voice.attachLive)
        throw Error("Server voice control is unavailable");
      const result = await services.voice.createLive(
        q.sdp,
        e.analysis,
        q.atMs,
        q.history,
      );
      store.recordUsage(e.id, result.session.id, 0, false);
      if (q.control) {
        const id = result.session.id;
        const control = new LiveControl(
          id,
          q.control,
          e.analysis,
          q.history,
          services.questions,
          (text) =>
            controls.get(id)?.socket?.send(
              JSON.stringify({
                type: "session.thinking.append",
                delegation_id: null,
                content: text,
              }),
            ),
          (totals) => console.log(`live intent ${id} ${describeCost(totals)}`),
          sessionPolicy.intentCalls,
        );
        const entry: {
          episode: string;
          control: LiveControl;
          socket?: LiveSideband;
          timer: ReturnType<typeof setTimeout>;
        } = {
          episode: e.id,
          control,
          timer: setTimeout(() => {
            entry.socket?.send(JSON.stringify({ type: "session.close" }));
            closeControl(id, liveSessionExpired);
          }, sessionPolicy.seconds * 1000),
        };
        controls.set(id, entry);
        try {
          entry.socket = await services.voice.attachLive!(
            id,
            (event) => {
              if (event.type === "session.closed") closeControl(id);
              else control.receive(event);
            },
            () =>
              closeControl(
                id,
                "Live sideband disconnected. Please reconnect the microphone.",
              ),
          );
        } catch (error) {
          closeControl(id);
          throw error;
        }
      }
      return { ...result, ...(q.control ? { control: true } : {}) };
    },
  );
  app.route<{ Params: { id: string }; Querystring: { sessionId?: string } }>({
    method: ["GET", "PUT"],
    url: "/api/episodes/:id/live-control",
    handler: async (req, reply) => {
      const update =
        req.method === "PUT"
          ? liveControlUpdateSchema.parse(req.body)
          : undefined;
      const entry = controls.get(
        update?.sessionId ?? req.query.sessionId ?? "",
      );
      if (!entry || entry.episode !== req.params.id)
        return reply
          .code(404)
          .send({ error: "Voice control session not found" });
      if (update) return { ok: entry.control.update(update) };
      const response = entry.control.subscribe();
      reply
        .code(response.status)
        .header("Content-Type", response.headers.get("Content-Type"));
      return reply.send(
        Readable.fromWeb(
          response.body as import("node:stream/web").ReadableStream,
        ),
      );
    },
  });
  app.post<{ Params: { id: string } }>(
    "/api/episodes/:id/usage",
    async (req) => {
      get(req.params.id);
      const data = z
        .object({
          sessionId: z.string().min(1).max(200),
          seconds: z.number().nonnegative(),
          finalized: z.boolean(),
        })
        .parse(req.body);
      store.recordUsage(
        req.params.id,
        data.sessionId,
        data.seconds,
        data.finalized,
      );
      if (data.finalized) closeControl(data.sessionId);
      return { ok: true };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/episodes/:id/usage",
    async (req) => {
      get(req.params.id);
      return store.usage(req.params.id);
    },
  );
  app.addHook("onReady", async () => jobs.start());
  return app;
}
