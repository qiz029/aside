import { randomUUID } from "node:crypto";
import { makeAnalysis, type AnalysisPort } from "@aside/engine/server";
import type { Passage } from "@aside/engine/core";
import { Store } from "./store.js";
import { planChunks } from "./media.js";
import { withMedia } from "./local-media.js";
import { publisherTranscript } from "./podcast-import.js";
import { publicFetch } from "./public-fetch.js";
import { nodePublicFetch } from "./public-fetch-node.js";
export { probe, probeAudio } from "./local-media.js";
export class Jobs {
  private running = false;
  constructor(
    private store: Store,
    private provider?: AnalysisPort,
    private request: typeof publicFetch = nodePublicFetch,
  ) {}
  async start() {
    for (const e of this.store.list())
      if (e.status === "analyzing") {
        e.status = "queued";
        e.stage = "等待恢复分析";
        this.store.put(e);
      }
    void this.drain();
  }
  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      for (const e of this.store.list().filter((e) => e.status === "queued")) {
        if (!this.provider && !e.podcast?.transcriptUrl) {
          this.store.put({
            ...e,
            status: "blocked",
            stage: "等待配置 OpenAI",
            error: "服务端尚未配置 OPENAI_API_KEY；原音频已保存。",
          });
          continue;
        }

        const update = (stage: string, progress: number) => {
          e.status = "analyzing";
          e.stage = stage;
          e.progress = progress;
          delete e.error;
          this.store.put(e);
        };
        try {
          if (e.podcast) {
            const transcript = await publisherTranscript(e, this.request);
            if (transcript) {
              e.analysis = makeAnalysis(transcript, {
                summary: "",
                hostStyle: "",
                speakers: [],
                groups: [],
              });
              e.status = "ready";
              e.stage = "文字稿已就绪";
              e.progress = 1;
              this.store.put(e);
              continue;
            }
            if (!this.provider)
              throw Error("服务端尚未配置 OPENAI_API_KEY，无法生成文字稿。");
            if (!this.store.objects.head(`episodes/${e.id}/original`)) {
              update("正在准备播客文字稿，可继续收听", 0.01);
              const response = await this.request(
                e.podcast.audioUrl,
                {},
                fetch,
                10 * 60 * 1000,
              );
              const limit = 256 * 1024 * 1024;
              if (Number(response.headers.get("content-length")) > limit) {
                await response.body?.cancel();
                throw Error("Podcast exceeds 256 MiB");
              }
              const bytes = async function* () {
                let size = 0;
                const reader = response.body!.getReader();
                try {
                  for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    size += value.byteLength;
                    if (size > limit) throw Error("Podcast exceeds 256 MiB");
                    yield value;
                  }
                } finally {
                  await reader.cancel();
                  reader.releaseLock();
                }
              };
              await this.store.objects.put(
                `episodes/${e.id}/original`,
                bytes(),
              );
            }
          }
          await withMedia(
            this.store.objects,
            `episodes/${e.id}/original`,
            async (media) => {
              update("检查音频", 0.02);
              e.durationMs = (await media.probe()).durationMs;
              let pauses = this.store.artifact<
                { startMs: number; endMs: number }[]
              >(e.id, "silences-v1");
              if (!pauses) {
                update("检测停顿与分块位置", 0.03);
                pauses = await media.silences();
                this.store.saveArtifact(e.id, "silences-v1", pauses);
              }
              const plan = planChunks(e.durationMs, pauses);
              this.store.saveArtifact(e.id, "transcript-plan", plan);
              const chunks = plan.length;
              const all: Passage[] = [];
              const info: Awaited<ReturnType<AnalysisPort["enrich"]>> = {
                summary: "",
                hostStyle: "",
                speakers: [],
                groups: [],
              };
              const remaining = plan.map((_, i) => i);
              while (remaining.length) {
                const priority = this.store.artifact<number>(
                  e.id,
                  "transcript-priority",
                );
                const next =
                  priority === undefined
                    ? -1
                    : remaining.findIndex(
                        (i) =>
                          priority >= plan[i].offsetMs &&
                          priority <= plan[i].offsetMs + plan[i].durationMs,
                      );
                const i = remaining.splice(Math.max(0, next), 1)[0];
                const offset = plan[i].offsetMs;
                const checkpoint = `analysis-v1-${i}`;
                let saved = this.store.artifact<{
                  passages: Passage[];
                  info: typeof info;
                }>(e.id, checkpoint);
                if (!saved) {
                  update(
                    `转录第 ${i + 1}/${chunks} 段`,
                    0.05 + (0.85 * (chunks - remaining.length - 1)) / chunks,
                  );
                  const audio = await media.chunk(offset, plan[i].durationMs);
                  let passages = this.store.artifact<Passage[]>(
                    e.id,
                    `transcript-v1-${i}`,
                  );
                  if (!passages) {
                    passages = await this.provider!.transcribe(audio, offset);
                    this.store.saveArtifact(
                      e.id,
                      `transcript-v1-${i}`,
                      passages,
                    );
                  }
                  update(
                    `分析语义与声音 ${i + 1}/${chunks}`,
                    0.05 + (0.85 * (chunks - remaining.length - 0.5)) / chunks,
                  );
                  saved = {
                    passages,
                    info: await this.provider!.enrich(
                      audio,
                      passages,
                      async (value) => {
                        this.store.saveArtifact(
                          e.id,
                          `evidence-v1-${i}-${randomUUID()}`,
                          value,
                        );
                      },
                    ),
                  };
                  this.store.saveArtifact(e.id, checkpoint, saved);
                }
                all.push(...saved.passages);
                info.summary += saved.info.summary + "\n";
                info.hostStyle += saved.info.hostStyle + "\n";
                info.speakers.push(
                  ...saved.info.speakers.map((s) => ({
                    ...s,
                    id: `${i}-${s.id}`,
                  })),
                );
                info.groups.push(...saved.info.groups);
              }
              if (!all.length) throw Error("没有识别到语音");
              e.analysis = makeAnalysis(all, {
                ...info,
                hostStyle: info.hostStyle.slice(0, 3000),
              });
              for (const anchor of e.analysis.anchors) {
                const pause = pauses
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
              e.status = "ready";
              e.stage = "分析完成";
              e.progress = 1;
              this.store.put(e);
            },
          );
        } catch (err) {
          const failedStage = e.stage;
          e.status = "failed";
          e.stage = `分析未完成 · ${failedStage}`;
          e.error = err instanceof Error ? err.message : "分析失败";
          this.store.put(e);
        }
      }
    } finally {
      this.running = false;
      if (this.store.list().some((e) => e.status === "queued"))
        void this.drain();
    }
  }
}
