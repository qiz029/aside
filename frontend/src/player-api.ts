import { CheckpointConflict } from "@aside/player-runtime/checkpoint-sync";
import { configureTrial, trialFetch } from "./trial-access";
import type {
  Episode,
  MicrophoneConfig,
  VoiceLifecycleConfig,
} from "@aside/engine/core";
import {
  checkpointSchema,
  errorSchema,
  type Checkpoint,
  type LiveRequest,
  type LiveResult,
  type QuestionRequest,
  type QuestionResult,
  type QuestionPhase,
} from "@aside/engine/contracts";
import { readQuestion } from "./question-stream";
import { MAX_UPLOAD_BYTES } from "@aside/engine/core";
export interface SpacePage {
  episodes: Episode[];
  pending: { id: string; title: string; size: number; createdAt: string }[];
  usedThisMonth: number;
  monthlyLimit: number;
  usedStorage: number;
  storageLimit: number;
  nextCursor: string | null;
}
export interface UploadOptions {
  title: string;
  signal?: AbortSignal;
  onStarted?: (id: string) => void;
  onProgress?: (
    bytes: number,
    total: number,
    phase: "uploading" | "processing",
  ) => void;
}
export interface PlayerBackend {
  question(
    id: string,
    request: QuestionRequest,
    signal: AbortSignal,
    progress: (phase: QuestionPhase) => void,
  ): Promise<QuestionResult>;
  live(id: string, request: LiveRequest): Promise<LiveResult>;
  transcribe(id: string, audio: Blob, signal: AbortSignal): Promise<string>;
  usage(
    id: string,
    data: { sessionId: string; seconds: number; finalized: boolean },
  ): Promise<void>;
}
export interface PlayerHealth {
  liveConfigured: boolean;
  trial?: boolean;
  uploadMode?: "multipart";
  uploadsEnabled?: boolean;
  microphone: MicrophoneConfig;
  voiceLifecycle: VoiceLifecycleConfig;
}
const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const paid =
    /\/(question|live|transcribe-question|retry)$/.test(path) ||
    (path.startsWith("/uploads") && init?.method === "POST");
  const response = await (paid ? trialFetch : fetch)("/api" + path, init);
  if (response.status === 409 && path.endsWith("/checkpoint"))
    throw new CheckpointConflict();
  if (!response.ok) {
    const error = errorSchema.safeParse(
      await response.json().catch(() => null),
    );
    throw Error(error.success ? error.data.error : response.statusText);
  }
  return response.json();
}
export const playerBackend: PlayerBackend = {
  async question(id, request, signal, progress) {
    const result = await readQuestion(
      await trialFetch(`/api/episodes/${id}/question`, {
        ...json(request),
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
        },
        signal,
      }),
      progress,
      request.revision,
    );
    return result;
  },
  live: (id, request) => api(`/episodes/${id}/live`, json(request)),
  async transcribe(id, audio, signal) {
    const body = new FormData();
    body.append("audio", audio, "question.wav");
    return (
      await api<{ text: string }>(`/episodes/${id}/transcribe-question`, {
        method: "POST",
        body,
        signal,
      })
    ).text;
  },
  async usage(id, data) {
    await api(`/episodes/${id}/usage`, { ...json(data), keepalive: true });
  },
};
export const episodeLibrary = {
  list: () => api<Episode[]>("/episodes"),
  space: (cursor?: string) =>
    api<SpacePage>(
      `/space/episodes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    ),
  delete: (id: string) =>
    api<{ ok: boolean }>(`/space/episodes/${id}`, { method: "DELETE" }),
  cancelUpload: (id: string) =>
    api<{ ok: boolean }>(`/uploads/${id}`, { method: "DELETE" }),
  get: (id: string) => api<Episode>(`/episodes/${id}`),
  async checkpoint(id: string) {
    const data = await api<unknown>(`/episodes/${id}/checkpoint`);
    return data === null ? null : checkpointSchema.parse(data);
  },
  save: (id: string, checkpoint: Checkpoint) =>
    api<Checkpoint>(`/episodes/${id}/checkpoint`, {
      ...json(checkpoint, "PUT"),
      keepalive: true,
    }),
  health: async () => {
    const health = await api<PlayerHealth>("/health");
    configureTrial(health.trial === true);
    return health;
  },
  retry: (id: string) => api(`/episodes/${id}/retry`, json({})),
  async upload(file: File, options?: UploadOptions) {
    if (file.size > MAX_UPLOAD_BYTES) throw Error("文件不能超过 1 GiB");
    const health = await episodeLibrary.health();
    if (health.uploadsEnabled === false) throw Error("当前仅开放示例节目试听");
    if (health.uploadMode === "multipart") {
      const upload = await api<{ id: string; partSize: number }>("/uploads", {
        ...json({
          title: (options?.title || file.name.replace(/\.[^.]+$/, ""))
            .trim()
            .slice(0, 200),
          size: file.size,
        }),
        signal: options?.signal,
      });
      options?.onStarted?.(upload.id);
      const parts: { partNumber: number; etag: string }[] = [];
      try {
        for (let offset = 0; offset < file.size; offset += upload.partSize) {
          const partNumber = parts.length + 1;
          parts.push(
            await api(`/uploads/${upload.id}/part?number=${partNumber}`, {
              method: "PUT",
              body: file.slice(offset, offset + upload.partSize),
              signal: options?.signal,
            }),
          );
          options?.onProgress?.(
            Math.min(offset + upload.partSize, file.size),
            file.size,
            "uploading",
          );
        }
        options?.signal?.throwIfAborted();
      } catch (error) {
        await api(`/uploads/${upload.id}`, { method: "DELETE" }).catch(
          () => {},
        );
        throw error;
      }
      // Do not abort after completion starts: the server may already be analyzing.
      options?.onProgress?.(file.size, file.size, "processing");
      return api<Episode>(`/uploads/${upload.id}/complete`, json({ parts }));
    }
    const body = new FormData();
    body.append("audio", file);
    return api<Episode>("/episodes", { method: "POST", body });
  },
};
