import { NativeModules, Platform, PermissionsAndroid } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { type UploadJournal } from "./upload-journal";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { File } from "expo-file-system";
import { fetch as fetchStream } from "expo/fetch";
import { readQuestion } from "@aside/player-runtime/question-stream";
import { readLiveControl } from "@aside/player-runtime/live-control-stream";
import {
  LiveSessionJournal,
  type RememberedLive,
} from "./live-session-journal";
import { withAbortTimeout } from "@aside/player-runtime/abort-timeout";
import type { Episode } from "@aside/engine/core";
import { checkpointSchema, type Checkpoint } from "@aside/engine/contracts";
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
  accountId: string | null = null;
  appleEnabled = false;
  onExpired?: () => void;
  private readonly liveJournal = new LiveSessionJournal({
    read: () => SecureStore.getItemAsync("aside.live"),
    write: (value) => SecureStore.setItemAsync("aside.live", value),
    remove: () => SecureStore.deleteItemAsync("aside.live"),
  });
  private recovery?: Promise<void>;
  async restore() {
    this.token = await SecureStore.getItemAsync("aside.token");
    // Start cleanup during account restoration. Offline failure is retried only
    // when the listener explicitly opens voice; no paid request is replayed.
    void this.recoverLive().catch(() => {});
  }
  private recoverLive() {
    const token = this.token;
    if (!token) return Promise.resolve();
    this.recovery ??= this.liveJournal
      .recover(token, (old) => this.closeRememberedLive(old))
      .catch((error) => {
        this.recovery = undefined;
        throw error;
      });
    return this.recovery;
  }
  private closeRememberedLive(old: RememberedLive) {
    return withAbortTimeout(
      new AbortController().signal,
      5000,
      async (signal) => {
        const response = await fetch(
          this.base + `/api/episodes/${old.episodeId}/usage`,
          {
            method: "POST",
            signal,
            credentials: "omit",
            headers: {
              Authorization: `Bearer ${old.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              sessionId: old.sessionId,
              seconds: 0,
              finalized: false,
              closed: true,
            }),
          },
        );
        if (!response.ok && ![401, 403, 404].includes(response.status))
          throw Error(
            "上次语音会话尚未关闭，请稍后重试 / The previous voice session is still closing. Please try again shortly.",
          );
      },
    );
  }
  headers() {
    return this.token
      ? { Authorization: `Bearer ${this.token}` }
      : ({} as Record<string, string>);
  }
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const requestToken = this.token;
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
      if (
        response.status === 401 &&
        requestToken &&
        requestToken === this.token
      )
        this.onExpired?.();
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
    this.accountId = result.user.id;
    this.token = result.token;
    this.recovery = undefined;
    await SecureStore.setItemAsync("aside.token", result.token);
    return result.user;
  }
  async forget() {
    const token = this.token;
    this.token = null;
    this.accountId = null;
    this.recovery = undefined;
    await SecureStore.deleteItemAsync("aside.token");
    if (token) await this.liveJournal.forget(token);
  }
  async logout() {
    await this.json("/auth/logout", {});
    await this.forget();
  }
  async me() {
    const result = await this.request<{
      user: User | null;
      appleEnabled?: boolean;
    }>("/auth/session");
    this.accountId = result.user?.id ?? null;
    this.appleEnabled = result.appleEnabled ?? false;
    return result;
  }
  appleStart(clientId: string) {
    return this.json<{ nonce: string }>("/auth/mobile/apple/start", {
      clientId,
    });
  }
  async appleVerify(nonce: string, code: string, name?: string) {
    const result = await this.json<{ user: User; token?: string }>(
      "/auth/mobile/apple/verify",
      { nonce, code, name },
    );
    this.accountId = result.user.id;
    if (result.token) {
      this.token = result.token;
      this.recovery = undefined;
      await SecureStore.setItemAsync("aside.token", result.token);
    }
    return result.user;
  }
  consent() {
    return this.request<{ accepted: boolean; version: string }>(
      "/auth/consent",
    );
  }
  acceptConsent(version: string) {
    return this.json("/auth/consent", { version });
  }
  revokeConsent() {
    return this.request("/auth/consent", { method: "DELETE" });
  }
  deleteAccount() {
    return this.json("/auth/account", { confirmation: "DELETE" }, "DELETE");
  }
  updateProfile(alias: string, description: string) {
    return this.json<{ user: User }>(
      "/profile",
      { alias, description },
      "PATCH",
    );
  }
  private uploadKey() {
    if (!this.accountId) throw new Error("Sign in to upload");
    return `aside.upload.${this.accountId}`;
  }
  async pendingUpload(): Promise<UploadJournal | null> {
    if (!this.accountId) return null;
    const raw = await AsyncStorage.getItem(this.uploadKey());
    return raw ? JSON.parse(raw) : null;
  }
  private async discardUpload(
    journal: UploadJournal,
    key: string,
    token: string | null,
  ) {
    await NativeModules.AsideUpload.cancel(journal.id);
    // Clear only this account's journal. A late cancellation cannot erase a replacement.
    const stored = await AsyncStorage.getItem(key);
    if (stored && JSON.parse(stored).id === journal.id)
      await AsyncStorage.removeItem(key);
    const file = new File(journal.file.uri);
    if (file.exists) file.delete();
    // Cleanup must not recurse through onExpired, and offline sign-out must stay bounded.
    if (token)
      await withAbortTimeout(new AbortController().signal, 5000, (signal) =>
        fetch(this.base + `/api/uploads/${journal.id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
          credentials: "omit",
          signal,
        }),
      ).catch(() => {});
  }
  async cancelUpload() {
    const key = this.accountId ? this.uploadKey() : null;
    const token = this.token;
    const journal = await this.pendingUpload();
    if (journal && key) await this.discardUpload(journal, key, token);
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
    onAnswer?: (text: string) => void,
  ) {
    progress("working");
    const requestToken = this.token;
    const response = await fetchStream(
      this.base + `/api/episodes/${id}/question`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.headers(),
          Accept: "application/x-ndjson",
          ...(onAnswer ? { "X-Aside-Answer-Stream": "1" } : {}),
        },
        body: JSON.stringify(request),
        signal,
        credentials: "omit",
      },
    );
    if (response.status === 401 && requestToken && requestToken === this.token)
      this.onExpired?.();
    return readQuestion(response, progress, request.revision, onAnswer);
  }
  async live(id: string, request: Parameters<PlayerBackend["live"]>[1]) {
    await this.recoverLive();
    const token = this.token;
    const result = await this.json<Awaited<ReturnType<PlayerBackend["live"]>>>(
      `/episodes/${id}/live`,
      {
        ...request,
        ...(request.control
          ? { control: { ...request.control, client: "mobile" } }
          : {}),
      },
    );
    if (token) {
      const entry = { token, episodeId: id, sessionId: result.session.id };
      try {
        if (token !== this.token) throw Error("Voice account changed");
        await this.liveJournal.remember(entry);
      } catch (error) {
        await this.closeRememberedLive(entry).catch(() => {});
        throw error;
      }
    }
    return result;
  }
  async control(
    id: string,
    sessionId: string,
    signal: AbortSignal,
    receive: Parameters<NonNullable<PlayerBackend["control"]>>[3],
  ) {
    const requestToken = this.token;
    const response = await fetchStream(
      this.base +
        `/api/episodes/${id}/live-control?sessionId=${encodeURIComponent(sessionId)}`,
      {
        headers: { ...this.headers(), Accept: "application/x-ndjson" },
        signal,
        credentials: "omit",
      },
    );
    if (response.status === 401 && requestToken && requestToken === this.token)
      this.onExpired?.();
    await readLiveControl(response, (event) => {
      // Buffered events from a cancelled/account-replaced stream have no authority.
      if (!signal.aborted && this.token === requestToken) receive(event);
    });
  }
  async updateControl(
    id: string,
    update: Parameters<NonNullable<PlayerBackend["updateControl"]>>[1],
    signal: AbortSignal,
  ) {
    const result = await this.request<{ ok: boolean }>(
      `/episodes/${id}/live-control`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
        signal,
      },
    );
    if (!result.ok) throw Error("Voice control session is no longer active");
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
    const token = this.token;
    await this.json(`/episodes/${id}/usage`, value);
    if (token && (value.closed || value.finalized))
      await this.liveJournal.forget(token, value.sessionId);
  }
  async upload(
    file: AudioFile,
    signal: AbortSignal,
    onProgress: (progress: number, phase: "uploading" | "processing") => void,
  ) {
    if (file.size > 1024 ** 3)
      throw Error("文件不能超过 1 GiB / Maximum file size: 1 GiB");
    const key = this.uploadKey();
    const token = this.token;
    checkCancelled(signal);
    let journal = await this.pendingUpload();
    if (journal && journal.file.uri !== file.uri)
      throw Error("Resume or cancel the pending upload first");
    if (!journal) {
      const started = await this.json<{ id: string; partSize: number }>(
        "/uploads",
        { title: file.name, size: file.size },
      );
      journal = { ...started, file, parts: [] };
      await AsyncStorage.setItem(key, JSON.stringify(journal));
    }
    try {
      checkCancelled(signal);
      if (Platform.OS === "android" && Number(Platform.Version) >= 33) {
        // Denying notification permission does not prevent an explicitly started transfer.
        await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
        );
        checkCancelled(signal);
      }
      const saved = await NativeModules.AsideUpload.status(journal.id);
      if (saved.state === "cancelled") {
        await this.discardUpload(journal, key, token);
        throw Error(
          "上传已取消，请重新选择音频 / Upload cancelled. Choose the audio file again.",
        );
      }
      checkCancelled(signal);
      if (this.token !== token) throw Error("Account changed during upload");
      if (saved.state !== "done") {
        const args = [
          journal.id,
          this.base,
          token,
          file.uri,
          file.size,
          journal.partSize,
        ];
        if (Platform.OS === "android") args.push(JSON.stringify(journal.parts));
        await NativeModules.AsideUpload.start(...args);
      }
      while (true) {
        checkCancelled(signal);
        if (this.token !== token) throw Error("Account changed during upload");
        const status = await NativeModules.AsideUpload.status(journal.id);
        if (status.state === "done") break;
        if (status.state === "cancelled") {
          await this.discardUpload(journal, key, token);
          throw Error(
            "上传已取消，请重新选择音频 / Upload cancelled. Choose the audio file again.",
          );
        }
        if (status.state === "paused" || status.state === "missing")
          throw Error(
            "上传已暂停，重试将从已保存的进度继续 / Upload paused. Retry to resume saved progress.",
          );
        onProgress(
          status.progress,
          status.state === "processing" ? "processing" : "uploading",
        );
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
      if (this.token !== token) throw Error("Account changed during upload");
      const result = await this.episode(journal.id);
      checkCancelled(signal);
      if (this.token !== token) throw Error("Account changed during upload");
      await NativeModules.AsideUpload.cancel(journal.id);
      const stored = await AsyncStorage.getItem(key);
      if (stored && JSON.parse(stored).id === journal.id)
        await AsyncStorage.removeItem(key);
      return result;
    } catch (error) {
      // Network errors retain the journal and acknowledged parts. Explicit cancel discards it.
      if (signal.aborted) await this.discardUpload(journal, key, token);
      throw error;
    }
  }
}
