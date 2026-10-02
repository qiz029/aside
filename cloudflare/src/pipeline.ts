import { enabled } from "./trial.js";
import { makeAnalysis, type AnalysisPort } from "@aside/engine/server";
import type { Episode, Passage } from "@aside/engine/core";
import { AudioProvider } from "../../backend/src/audio-provider.js";
import { CloudStore, positiveLimit } from "./store.js";
import type { Env } from "./env.js";
import { publisherTranscript } from "../../backend/src/podcast-import.js";
import { publicFetch } from "../../backend/src/public-fetch.js";
import { PODCAST_DOWNLOAD_LIMIT } from "./storage.js";
export interface Manifest {
  durationMs: number;
  mimeType: string;
  /** Embedded artwork was extracted; absent in manifests written before covers. */
  cover?: boolean;
  pauses: { startMs: number; endMs: number }[];
  plan: { offsetMs: number; durationMs: number }[];
}
export interface Steps {
  do(name: string, callback: () => Promise<string>): Promise<string>;
}
/** Media prepared on one container instance; valid only inside the step that opened it. */
export interface MediaSession {
  manifest: Manifest;
  segment(index: number): Promise<Uint8Array>;
  cover(): Promise<Uint8Array | undefined>;
  close(): Promise<void>;
}
export interface MediaProcessor {
  open(id: string): Promise<MediaSession>;
}
const DEFAULT_CONCURRENCY = 6;
/** Step outputs are keys; structured records live in D1, audio bytes in R2. */
export async function analyzeEpisode(
  env: Pick<Env, "DB" | "AUDIO" | "OPENAI_API_KEY" | "AI_ENABLED" | "ANALYSIS_CONCURRENCY">,
  id: string,
  step: Steps,
  media: MediaProcessor,
  suppliedProvider?: AudioProvider,
) {
  const store = new CloudStore(env.DB, env.AUDIO);
  const prefix = `episodes/${id}/analysis-v1`;
  const read = async <T>(key: string): Promise<T> => {
    const value = await store.records.get<T>(key);
    if (value === undefined) throw Error("Missing analysis artifact");
    return value;
  };
  const write = (key: string, value: unknown) => store.records.put(key, value);
  async function update(
    stage: string,
    progress: number,
    status: Episode["status"] = "analyzing",
  ) {
    const row = await store.row(id);
    const episode = JSON.parse(row.metadata) as Episode;
    // Segments finish out of order, so progress within one status never moves back.
    episode.progress =
      episode.status === status ? Math.max(episode.progress, progress) : progress;
    episode.stage = stage;
    episode.status = status;
    delete episode.error;
    await store.update(episode);
    return episode;
  }
  try {
    const imported: Episode = JSON.parse((await store.row(id)).metadata);
    if (imported.podcast) {
      const key = await step.do("import-podcast", async () => {
        const transcript = await publisherTranscript(imported);
        if (transcript) {
          const key = `${prefix}/complete.json`;
          await write(key, makeAnalysis(transcript, { summary: "", hostStyle: "", speakers: [], groups: [] }));
          await store.update({ ...imported, podcast: { ...imported.podcast!, reservedBytes: 0 }, status: "ready", stage: "文字稿已就绪", progress: 1 }, key);
          return "ready";
        }
        const key = `episodes/${id}/original`;
        if (!(await env.AUDIO.head(key))) {
          await update("正在准备播客文字稿，可继续收听", 0.01);
          const response = await publicFetch(imported.podcast!.audioUrl, {}, fetch, 10 * 60 * 1000);
          const length = Number(response.headers.get("content-length"));
          if (!Number.isSafeInteger(length) || length < 44 || length > PODCAST_DOWNLOAD_LIMIT) {
            await response.body?.cancel();
            throw Error("Podcast host must provide an audio file size up to 256 MiB");
          }
          await store.row(id);
          await env.AUDIO.put(key, response.body!, { httpMetadata: { contentType: imported.mimeType ?? "audio/mpeg" } });
        }
        const object = await env.AUDIO.head(key);
        if (object) {
          const current: Episode = JSON.parse((await store.row(id)).metadata);
          await store.update({ ...current, podcast: { ...current.podcast!, reservedBytes: object.size } });
        }
        return key;
      });
      if (key === "ready") return;
    }
    if (!env.OPENAI_API_KEY && !suppliedProvider)
      throw Error("Analysis provider not configured");
    const provider = suppliedProvider ?? new AudioProvider(env.OPENAI_API_KEY!);
    const manifestKey = `${prefix}/manifest.json`;
    const segmentKey = (index: number) => `${prefix}/chunk-${index}.mp3`;
    const coverKey = `episodes/${id}/cover.jpg`;
    // The only step that needs the container. It leaves every segment in R2
    // before it ends, so a lost instance costs a retry of this step and nothing later.
    await step.do("segment-audio", async () => {
      if (await store.records.has(manifestKey)) {
        const saved = await read<Manifest>(manifestKey);
        const present = await Promise.all(
          saved.plan.map((_, index) => env.AUDIO.head(segmentKey(index))),
        );
        if (present.every(Boolean)) return manifestKey;
      }
      await update("检查音频与分块", 0.02);
      const session = await media.open(id);
      try {
        const { manifest } = session;
        for (let index = 0; index < manifest.plan.length; index++) {
          if (await env.AUDIO.head(segmentKey(index))) continue;
          const bytes = await session.segment(index);
          await store.row(id);
          await env.AUDIO.put(segmentKey(index), bytes, {
            httpMetadata: { contentType: "audio/mpeg" },
          });
        }
        let cover = false;
        if (manifest.cover)
          try {
            const bytes = await session.cover();
            if (bytes) {
              await store.row(id);
              await env.AUDIO.put(coverKey, bytes, {
                httpMetadata: { contentType: "image/jpeg" },
              });
              cover = true;
            }
          } catch {
            // Artwork is decorative; losing it must not fail the analysis.
          }
        await write(manifestKey, { ...manifest, cover });
      } finally {
        await session.close().catch(() => {});
      }
      return manifestKey;
    });
    const manifest = await read<Manifest>(manifestKey);
    {
      const row = await store.row(id);
      const episode = JSON.parse(row.metadata) as Episode;
      await store.update({
        ...episode,
        ...(manifest.cover && (await env.AUDIO.head(coverKey))
          ? { cover: true }
          : {}),
        durationMs: manifest.durationMs,
        mimeType: manifest.mimeType,
        stage: "正在自动分析",
        status: "analyzing",
      });
    }
    const total = manifest.plan.length;
    let finishedSteps = 0;
    const report = () =>
      update(
        `已完成 ${Math.floor(finishedSteps / 2)}/${total} 段`,
        0.05 + (0.85 * finishedSteps) / (2 * total),
      );
    const analyzeSegment = async (i: number) => {
      const chunk = segmentKey(i),
        transcript = `${prefix}/transcript-${i}.json`,
        enriched = `${prefix}/enriched-${i}.json`;
      await step.do(`transcribe-${i}`, async () => {
        if (!(await store.records.has(transcript))) {
          await report();
          if (!(await enabled(env))) throw Error("AI processing disabled");
          const object = await env.AUDIO.get(chunk);
          if (!object) throw Error("Missing audio chunk");
          const passages = await provider.transcribeAudio(
            new Uint8Array(await object.arrayBuffer()),
            manifest.plan[i].offsetMs,
          );
          await store.row(id);
          await write(transcript, passages);
        }
        return transcript;
      });
      finishedSteps++;
      await step.do(`enrich-${i}`, async () => {
        if (!(await store.records.has(enriched))) {
          await report();
          if (!(await enabled(env))) throw Error("AI processing disabled");
          const object = await env.AUDIO.get(chunk);
          if (!object) throw Error("Missing audio chunk");
          const evidence = `${prefix}/evidence-${i}-${crypto.randomUUID()}.json`;
          const info = await provider.enrichAudio(
            new Uint8Array(await object.arrayBuffer()),
            await read<Passage[]>(transcript),
            async (value) => {
              await store.row(id);
              await store.records.put(evidence, value);
            },
          );
          await store.row(id);
          await write(enriched, info);
        }
        return enriched;
      });
      finishedSteps++;
    };
    // Segments are independent; each keeps transcribe before enrich. After a
    // failure no new segment starts, but steps already running finish first.
    const workers = Math.min(
      total,
      positiveLimit(env.ANALYSIS_CONCURRENCY, DEFAULT_CONCURRENCY),
    );
    const remaining = manifest.plan.map((_, i) => i);
    let failure: { error: unknown } | undefined;
    await Promise.all(
      Array.from({ length: workers }, async () => {
        while (!failure && remaining.length) {
          const priority = await store.records.get<number>(`episodes/${id}/transcript-priority`);
          if (failure || !remaining.length) break;
          const next = priority === undefined ? -1 : remaining.findIndex((i) => priority >= manifest.plan[i].offsetMs && priority <= manifest.plan[i].offsetMs + manifest.plan[i].durationMs);
          const index = remaining.splice(Math.max(0, next), 1)[0];
          try {
            await analyzeSegment(index);
          } catch (error) {
            failure ??= { error };
          }
        }
      }),
    );
    if (failure) throw failure.error;
    await step.do("assemble", async () => {
      const all: Passage[] = [];
      const info: Awaited<ReturnType<AnalysisPort["enrich"]>> = {
        summary: "",
        hostStyle: "",
        speakers: [],
        groups: [],
      };
      for (let i = 0; i < manifest.plan.length; i++) {
        all.push(...(await read<Passage[]>(`${prefix}/transcript-${i}.json`)));
        const next = await read<typeof info>(`${prefix}/enriched-${i}.json`);
        info.summary += next.summary + "\n";
        info.hostStyle += next.hostStyle + "\n";
        info.speakers.push(
          ...next.speakers.map((s) => ({ ...s, id: `${i}-${s.id}` })),
        );
        info.groups.push(...next.groups);
      }
      if (!all.length) throw Error("No speech found");
      const analysis = makeAnalysis(all, {
        ...info,
        hostStyle: info.hostStyle.slice(0, 3000),
      });
      for (const anchor of analysis.anchors) {
        const pause = manifest.pauses
          .filter(
            (p) =>
              p.endMs <= anchor.startMs + 120 &&
              p.endMs >= anchor.startMs - 350,
          )
          .at(-1);
        if (pause)
          anchor.startMs = Math.max(
            pause.startMs,
            Math.min(anchor.startMs, pause.endMs - 50),
          );
      }
      const key = `${prefix}/complete.json`;
      await write(key, analysis);
      const row = await store.row(id),
        episode = JSON.parse(row.metadata) as Episode;
      await store.update(
        {
          ...episode,
          durationMs: manifest.durationMs,
          mimeType: manifest.mimeType,
          status: "ready",
          stage: "分析完成",
          progress: 1,
          error: undefined,
        },
        key,
      );
      return key;
    });
  } catch (error) {
    await step.do("record-failure", async () => {
      const row = await store.row(id),
        episode = JSON.parse(row.metadata) as Episode;
      if (episode.status !== "ready" && episode.status !== "blocked")
        await store.update({
          ...episode,
          status: "failed",
          stage: "分析未完成",
          error: "分析失败，已完成分段可以复用，请重试。",
        });
      return id;
    });
    throw error;
  }
}
