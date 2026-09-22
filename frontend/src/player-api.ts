import { resumableUpload } from "./resumable-upload";
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
  type LiveControlEvent,
  type LiveControlUpdate,
} from "@aside/engine/contracts";
import { readQuestion } from "./question-stream";
import { readLiveControl } from "./live-control-stream";
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
  owner: string;
  resumeId?: string;
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
    onAnswer?: (text: string) => void,
  ): Promise<QuestionResult>;
  live(id: string, request: LiveRequest): Promise<LiveResult>;
  control?(
    id: string,
    sessionId: string,
    signal: AbortSignal,
    receive: (event: LiveControlEvent) => void,
  ): Promise<void>;
  updateControl?(
    id: string,
    update: LiveControlUpdate,
    signal: AbortSignal,
  ): Promise<void>;
  transcribe(id: string, audio: Blob, signal: AbortSignal): Promise<string>;
  usage(
    id: string,
    data: {
      sessionId: string;
      seconds: number;
      finalized: boolean;
      closed?: boolean;
    },
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
    const body = await response.json().catch(() => null);
    const error = errorSchema.safeParse(body);
    throw Object.assign(
      Error(error.success ? error.data.error : response.statusText),
      {
        code: typeof body?.code === "string" ? body.code : undefined,
        status: response.status,
      },
    );
  }
  return response.json();
}
/**
 * The server admits one voice session and one operation per listener. A slot
 * still held by a request this page already abandoned (a slow session start,
 * an aborted transcription) frees within seconds, so wait for it instead of
 * surfacing a failure the listener did nothing to cause.
 */
async function whenFree<T>(run: () => Promise<T>, signal?: AbortSignal) {
  for (let attempt = 0; ; attempt++)
    try {
      return await run();
    } catch (error) {
      if ((error as { code?: string }).code !== "trial_busy" || attempt >= 5)
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      signal?.throwIfAborted();
    }
}
export const playerBackend: PlayerBackend = {
  async question(id, request, signal, progress, onAnswer) {
    const result = await readQuestion(
      await trialFetch(`/api/episodes/${id}/question`, {
        ...json(request),
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
          ...(onAnswer ? { "X-Aside-Answer-Stream": "1" } : {}),
        },
        signal,
      }),
      progress,
      request.revision,
      onAnswer,
    );
    return result;
  },
  live: (id, request) =>
    whenFree(() => api(`/episodes/${id}/live`, json(request))),
  async control(id, sessionId, signal, receive) {
    await readLiveControl(
      await fetch(
        `/api/episodes/${id}/live-control?sessionId=${encodeURIComponent(sessionId)}`,
        {
          headers: { Accept: "application/x-ndjson" },
          signal,
        },
      ),
      receive,
    );
  },
  async updateControl(id, update, signal) {
    const result = await api<{ ok: boolean }>(`/episodes/${id}/live-control`, {
      ...json(update, "PUT"),
      signal,
    });
    if (!result.ok) throw Error("Voice control session is no longer active");
  },
  async transcribe(id, audio, signal) {
    const body = new FormData();
    body.append("audio", audio, "question.wav");
    return (
      await whenFree(
        () =>
          api<{ text: string }>(`/episodes/${id}/transcribe-question`, {
            method: "POST",
            body,
            signal,
          }),
        signal,
      )
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
      if (!options?.owner) throw Error("请先登录后上传");
      const run = () =>
        resumableUpload<Episode>(file, { ...options, request: api });
      if (navigator.locks)
        return navigator.locks.request(
          `aside.upload.${options.owner}`,
          { ifAvailable: true },
          (lock) => {
            if (!lock) throw Error("另一个标签页正在上传，请等待完成后重试");
            return run();
          },
        );
      return run();
    }

    options?.onProgress?.(0, file.size, "uploading");
    const body = new FormData();
    body.append("audio", file);
    return api<Episode>("/episodes", {
      method: "POST",
      body,
      signal: options?.signal,
    });
  },
};
