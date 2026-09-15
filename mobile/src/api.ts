import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { File } from "expo-file-system";
import type { Episode } from "@aside/engine/core";
import {
  checkpointSchema,
  questionResultSchema,
  type Checkpoint,
} from "@aside/engine/contracts";
import { CheckpointConflict } from "@aside/player-runtime/checkpoint-sync";
import type { PlayerBackend, PlayerHealth } from "@aside/player-runtime/ports";
export interface User {
  id: string;
  email: string;
  alias: string;
  description: string;
  avatarUrl?: string;
}
export interface AudioFile {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
}
export interface SpacePage {
  episodes: Episode[];
  nextCursor: string | null;
  usedThisMonth: number;
  monthlyLimit: number;
  usedStorage: number;
  storageLimit: number;
}
// React Native's AbortSignal lacks throwIfAborted on SDK 54.
function checkCancelled(signal: AbortSignal) {
  if (!signal.aborted) return;
  const error = new Error("Upload cancelled");
  error.name = "AbortError";
  throw error;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export class MobileApi implements PlayerBackend {
  readonly base = (
    (Constants.expoConfig?.extra?.apiUrl as string) ?? "https://asidefm.com"
  ).replace(/\/$/, "");
  token: string | null = null;
  onExpired?: () => void;
  async restore() {
    this.token = await SecureStore.getItemAsync("aside.token");
  }
  headers() {
    return this.token
      ? { Authorization: `Bearer ${this.token}` }
      : ({} as Record<string, string>);
  }
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(this.base + "/api" + path, {
      ...init,
      headers: { ...this.headers(), ...init.headers },
      credentials: "omit",
    });
    if (response.status === 409 && path.endsWith("/checkpoint"))
      throw new CheckpointConflict();
    if (!response.ok) {
      const error = await response
        .json()
        .catch(() => ({ error: "Request failed" }));
      if (response.status === 401) this.onExpired?.();
      throw new ApiError(
        response.status,
        error.error ?? `HTTP ${response.status}`,
      );
    }
    return response.json();
  }
  json<T>(path: string, value: unknown, method = "POST") {
    return this.request<T>(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  }
  startLogin(email: string) {
    return this.json("/auth/mobile/email/start", { email });
  }
  async verify(email: string, code: string) {
    const result = await this.json<{
      token: string;
      user: User;
      expiresAt: number;
    }>("/auth/mobile/email/verify", { email, code });
    this.token = result.token;
    await SecureStore.setItemAsync("aside.token", result.token);
    return result.user;
  }
  async forget() {
    this.token = null;
    await SecureStore.deleteItemAsync("aside.token");
  }
  async logout() {
    await this.json("/auth/logout", {});
    await this.forget();
  }
  me() {
    return this.request<{ user: User | null }>("/auth/session");
  }
  list() {
    return this.request<Episode[]>("/episodes");
  }
  space(cursor?: string) {
    return this.request<SpacePage>(
      "/space/episodes" +
        (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""),
    );
  }
  episode(id: string) {
    return this.request<Episode>(`/episodes/${id}`);
  }
  health() {
    return this.request<PlayerHealth>("/health");
  }
  async checkpoint(id: string) {
    const value = await this.request<unknown>(`/episodes/${id}/checkpoint`);
    return value === null ? null : checkpointSchema.parse(value);
  }
  async save(id: string, value: Checkpoint) {
    return checkpointSchema.parse(
      await this.json(`/episodes/${id}/checkpoint`, value, "PUT"),
    );
  }
  retry(id: string) {
    return this.json(`/episodes/${id}/retry`, {});
  }
  async question(
    id: string,
    request: Parameters<PlayerBackend["question"]>[1],
    signal: AbortSignal,
    progress: Parameters<PlayerBackend["question"]>[3],
  ) {
    progress("working");
    return questionResultSchema.parse(
      await this.request(`/episodes/${id}/question`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(request),
        signal,
      }),
    );
  }
  live(id: string, request: Parameters<PlayerBackend["live"]>[1]) {
    return this.json<Awaited<ReturnType<PlayerBackend["live"]>>>(
      `/episodes/${id}/live`,
      request,
    );
  }
  async transcribe(id: string, audio: unknown, signal: AbortSignal) {
    const body = new FormData();
    const file = audio as AudioFile;
    body.append("audio", {
      uri: file.uri,
      name: file.name,
      type: file.mimeType,
    } as unknown as Blob);
    return (
      await this.request<{ text: string }>(
        `/episodes/${id}/transcribe-question`,
        { method: "POST", body, signal },
      )
    ).text;
  }
  async usage(id: string, value: Parameters<PlayerBackend["usage"]>[1]) {
    await this.json(`/episodes/${id}/usage`, value);
  }
  async upload(
    file: AudioFile,
    signal: AbortSignal,
    onProgress: (progress: number, phase: "uploading" | "processing") => void,
  ) {
    if (file.size > 1024 ** 3)
      throw Error("文件不能超过 1 GiB / Maximum file size: 1 GiB");
    const upload = await this.json<{ id: string; partSize: number }>(
      "/uploads",
      { title: file.name, size: file.size },
    );
    let completed = false;
    try {
      const source = new File(file.uri),
        handle = source.open();
      const parts: { partNumber: number; etag: string }[] = [];
      try {
        for (
          let offset = 0, n = 1;
          offset < file.size;
          offset += upload.partSize, n++
        ) {
          checkCancelled(signal);
          handle.offset = offset;
          const bytes = handle.readBytes(
            Math.min(upload.partSize, file.size - offset),
          );
          const part = await this.request<{ etag: string }>(
            `/uploads/${upload.id}/part?number=${n}`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/octet-stream" },
              body: bytes as unknown as BodyInit,
              signal,
            },
          );
          parts.push({ partNumber: n, etag: part.etag });
          onProgress(
            Math.min(1, (offset + bytes.length) / file.size),
            "uploading",
          );
        }
      } finally {
        handle.close();
      }
      checkCancelled(signal);
      completed = true;
      onProgress(1, "processing");
      return await this.json<Episode>(`/uploads/${upload.id}/complete`, {
        parts,
      });
    } catch (error) {
      if (!completed)
        await this.request(`/uploads/${upload.id}`, { method: "DELETE" }).catch(
          () => {},
        );
      throw error;
    }
  }
}
