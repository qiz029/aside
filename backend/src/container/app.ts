import { normalizeQuestion } from "../question-audio.js";
import Fastify from "fastify";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat, rename, readFile, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { z } from "zod";
import { MAX_AUDIO_DURATION_MS, MAX_UPLOAD_BYTES } from "@aside/engine/core";
import { probeAudio } from "../jobs.js";
import { extractCover } from "../local-media.js";
import { cutSegments, encodeSpeechTrack, planChunks } from "../media.js";
const idSchema = z.string().uuid();
class AdmissionError extends Error {}
/** Bounds CPU, disk and model work before any encoding, independently of compressed size. */
export async function admitAudio(path: string) {
  let metadata: Awaited<ReturnType<typeof probeAudio>>;
  try {
    metadata = await probeAudio(path);
  } catch {
    throw new AdmissionError("文件不包含可读取的音轨");
  }
  if (metadata.durationMs > MAX_AUDIO_DURATION_MS)
    throw new AdmissionError("单个音频不能超过 5 小时");
  return metadata;
}
/**
 * Internal binding only. No user-supplied URL/path/command is ever executed.
 * `/prepare` produces every segment in one request; the caller reads them back
 * within the same Workflow step, so nothing here has to outlive the instance.
 */
export function mediaApp(root: string) {
  const app = Fastify({ logger: false });
  let busy = false;
  app.addContentTypeParser("application/octet-stream", (_request, body, done) =>
    done(null, body),
  );
  app.setErrorHandler((error, _req, reply) =>
    reply
      .code(
        error instanceof AdmissionError
          ? 422
          : error instanceof z.ZodError
            ? 400
            : 500,
      )
      .send({
        error:
          error instanceof AdmissionError
            ? error.message
            : "Media operation failed",
      }),
  );
  app.get("/health", async () => ({ ok: true }));
  let questionBusy = false;
  app.post("/question", async (req, reply) => {
    if (questionBusy)
      return reply.code(429).send({ error: "Question decoder busy" });
    questionBusy = true;
    try {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of req.raw) {
        total += chunk.length;
        if (total > 2 * 1024 * 1024)
          throw new AdmissionError("Question size limit");
        chunks.push(Buffer.from(chunk));
      }
      let audio: Uint8Array;
      try {
        audio = await normalizeQuestion(Buffer.concat(chunks));
      } catch {
        throw new AdmissionError(
          "Question must contain valid audio of at most 30 seconds",
        );
      }
      return reply.type("audio/wav").send(Buffer.from(audio));
    } finally {
      questionBusy = false;
    }
  });
  app.post<{ Querystring: { id: string } }>("/prepare", async (req, reply) => {
    const id = idSchema.parse(req.query.id);
    if (busy) return reply.code(429).send({ error: "Media processor busy" });
    busy = true;
    const dir = join(root, id);
    try {
      // A retried attempt starts from a clean directory.
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      let size = 0;
      await pipeline(
        req.raw,
        async function* (source) {
          for await (const chunk of source) {
            size += chunk.length;
            if (size > MAX_UPLOAD_BYTES)
              throw new AdmissionError("文件超过 1 GiB 上限");
            yield chunk;
          }
        },
        createWriteStream(join(dir, "upload")),
      );
      const original = join(dir, "original");
      await rename(join(dir, "upload"), original);
      const metadata = await admitAudio(original);
      const cover = await extractCover(original, join(dir, "cover.jpg"));
      const track = join(dir, "speech.mp3");
      const pauses = await encodeSpeechTrack(original, track);
      const plan = await cutSegments(
        track,
        planChunks(metadata.durationMs, pauses),
        dir,
      );
      await Promise.all([rm(original), rm(track)]);
      const result = { ...metadata, cover, pauses, plan };
      await writeFile(join(dir, "manifest.json"), JSON.stringify(result));
      return result;
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    } finally {
      busy = false;
    }
  });
  const prepared = async (id: string) => {
    try {
      return JSON.parse(
        await readFile(join(root, id, "manifest.json"), "utf8"),
      ) as { cover?: boolean; plan: unknown[] };
    } catch {
      return undefined;
    }
  };
  app.get<{ Querystring: { id: string; index: string } }>(
    "/chunk",
    async (req, reply) => {
      const id = idSchema.parse(req.query.id);
      const index = z.coerce
        .number()
        .int()
        .min(0)
        .max(1000)
        .parse(req.query.index);
      const manifest = await prepared(id);
      if (!manifest) return reply.code(409).send({ error: "Source not prepared" });
      if (!manifest.plan[index])
        return reply.code(400).send({ error: "Invalid chunk" });
      const path = join(root, id, `segment-${index}.mp3`);
      const file = await stat(path);
      reply.type("audio/mpeg").header("Content-Length", file.size);
      return reply.send(createReadStream(path));
    },
  );
  app.get<{ Querystring: { id: string } }>("/cover", async (req, reply) => {
    const id = idSchema.parse(req.query.id);
    const manifest = await prepared(id);
    if (!manifest) return reply.code(409).send({ error: "Source not prepared" });
    if (!manifest.cover) return reply.code(404).send({ error: "No cover" });
    return reply
      .type("image/jpeg")
      .send(await readFile(join(root, id, "cover.jpg")));
  });
  app.delete<{ Querystring: { id: string } }>("/source", async (req) => {
    const id = idSchema.parse(req.query.id);
    await rm(join(root, id), { recursive: true, force: true });
    return { ok: true };
  });
  return app;
}
