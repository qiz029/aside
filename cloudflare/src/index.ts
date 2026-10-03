import { Container, getContainer } from "@cloudflare/containers";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Env, AnalysisJob } from "./env.js";
import {
  analyzeEpisode,
  type Manifest,
  type MediaProcessor,
} from "./pipeline.js";
import { CloudStore } from "./store.js";
export { default } from "./api.js";
export class MediaContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "5m";
}
/** Matches `max_instances` in the Wrangler container config. */
const MEDIA_INSTANCES = 2;
export class EpisodeAnalysis extends WorkflowEntrypoint<Env, AnalysisJob> {
  async run(event: WorkflowEvent<AnalysisJob>, step: WorkflowStep) {
    const id = event.payload.episodeId;
    const media: MediaProcessor = {
      open: async () => {
        // Chosen per attempt, so a retry is not pinned to a lost or busy instance.
        const instance = getContainer(
          this.env.MEDIA,
          `media-${Math.floor(Math.random() * MEDIA_INSTANCES)}`,
        );
        const source = await this.env.AUDIO.get(`episodes/${id}/original`);
        if (!source) throw Error("Missing original audio");
        const result = await instance.fetch(
          new Request(`http://media/prepare?id=${id}`, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: source.body,
          }),
        );
        if (result.status === 422) {
          const detail = (await result.json().catch(() => null)) as { error?: string } | null;
          const store = new CloudStore(this.env.DB, this.env.AUDIO);
          const row = await store.row(id);
          const episode = JSON.parse(row.metadata);
          await store.update({
            ...episode,
            status: "blocked",
            stage: "音频不符合上传要求",
            error: detail?.error ?? "文件不包含可处理的音频",
          });
          await this.env.DB.prepare("UPDATE uploads SET state='rejected' WHERE id=?")
            .bind(id).run();
          await this.env.AUDIO.delete(`episodes/${id}/original`);
          await this.env.DB.prepare("DELETE FROM uploads WHERE id=? AND state='rejected'")
            .bind(id).run();
          throw new NonRetryableError("Audio admission rejected");
        }
        if (!result.ok) throw Error("Audio preparation failed");
        return {
          manifest: await result.json<Manifest>(),
          segment: async (index) => {
            const response = await instance.fetch(
              new Request(`http://media/chunk?id=${id}&index=${index}`),
            );
            if (!response.ok) throw Error("Audio segment unavailable");
            return new Uint8Array(await response.arrayBuffer());
          },
          cover: async () => {
            const response = await instance.fetch(
              new Request(`http://media/cover?id=${id}`),
            );
            if (response.status === 404) return undefined;
            if (!response.ok) throw Error("Cover extraction failed");
            return new Uint8Array(await response.arrayBuffer());
          },
          close: async () => {
            await instance.fetch(
              new Request(`http://media/source?id=${id}`, { method: "DELETE" }),
            );
          },
        };
      },
    };
    await analyzeEpisode(
      this.env,
      id,
      {
        do: (name, callback) =>
          step.do(
            name,
            name === "segment-audio"
              ? // A replacement container instance can take minutes to arrive.
                {
                  retries: { limit: 5, delay: "1 minute", backoff: "exponential" },
                  timeout: "30 minutes",
                }
              : {
                  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
                  timeout: "5 minutes",
                },
            callback,
          ),
      },
      media,
    );
  }
}

export { LiveSupervisor } from "./live-supervisor.js";

export { GeminiSupervisor } from "./gemini-supervisor.js";
