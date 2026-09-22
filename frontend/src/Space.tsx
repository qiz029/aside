import { readUpload, forgetUpload } from "./resumable-upload";
import { LibraryDrawer } from "./LibraryDrawer";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Episode } from "@aside/engine/core";
import { MAX_AUDIO_DURATION_MS, MAX_UPLOAD_BYTES } from "@aside/engine/core";
import { episodeLibrary, type SpacePage } from "./player-api";
import { homeHref, message, t } from "./i18n";
import { LanguageSelect } from "./LanguageSelect";
import "./space.css";
import { audioCard } from "./library-item";

interface SpaceUser {
  id: string;
  alias: string;
  description: string;
  avatarUrl: string | null;
}
const formatSize = (bytes: number) =>
  `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
const fileTitle = (name: string) =>
  (name.replace(/\.[^.]+$/, "").trim() || name).slice(0, 200);

function inspectDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const audio = document.createElement("audio");
    const url = URL.createObjectURL(file);
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 8000);
    audio.preload = "metadata";
    audio.onloadedmetadata = () =>
      finish(
        Number.isFinite(audio.duration)
          ? Math.round(audio.duration * 1000)
          : null,
      );
    audio.onerror = () => finish(null);
    audio.src = url;
  });
}

export function Space({
  accountControl,
  accountVersion,
  onOpen,
  activeEpisodeId,
  player,
  publicHref,
}: {
  accountControl: ReactNode;
  accountVersion: number;
  onOpen: (id: string, userInitiated?: boolean) => void;
  activeEpisodeId?: string;
  player?: (navigation: ReactNode) => ReactNode;
  publicHref: string;
}) {
  const [user, setUser] = useState<SpaceUser | null>();
  const [page, setPage] = useState<SpacePage>();
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const [phase, setPhase] = useState<"uploading" | "processing">("uploading");
  const [checking, setChecking] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [activeUploadId, setActiveUploadId] = useState("");
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [uploadEnabled, setUploadEnabled] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const uploadEpoch = useRef(0);
  const resumeTarget = useRef<string | undefined>(undefined);
  const lastFile = useRef<{ id: string; file: File } | null>(null);
  const cancelRequested = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const uploadBusy = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const loadedPages = useRef(1);
  const refreshVersion = useRef(0);

  async function refresh() {
    const version = ++refreshVersion.current;
    const first = await episodeLibrary.space();
    let last = first;
    const items = [...first.episodes];
    for (
      let index = 1;
      index < loadedPages.current && last.nextCursor;
      index++
    ) {
      last = await episodeLibrary.space(last.nextCursor);
      items.push(...last.episodes);
    }
    if (version !== refreshVersion.current) return;
    setPage({ ...first, nextCursor: last.nextCursor });
    setEpisodes(items);
  }
  useEffect(() => {
    void episodeLibrary
      .health()
      .then((health) => setUploadEnabled(health.uploadsEnabled === true))
      .catch(() => {});
  }, []);
  useEffect(() => {
    let active = true;
    setUser(undefined);
    setError("");
    setProgress(null);
    setChecking(false);
    setActiveUploadId("");
    setPage(undefined);
    setEpisodes([]);
    loadedPages.current = 1;
    refreshVersion.current++;
    void fetch("/api/auth/session")
      .then((response) => response.json())
      .then(async (session: { user: SpaceUser | null }) => {
        if (!active) return;
        setUser(session.user);
        if (session.user) await refresh();
        else {
          setPage(undefined);
          setEpisodes([]);
        }
      })
      .catch(() => active && setError(t("请求失败，请重试")));
    return () => {
      active = false;
      refreshVersion.current++;
      uploadEpoch.current++;
      controller.current?.abort();
      controller.current = null;
      uploadBusy.current = false;
      lastFile.current = null;
      resumeTarget.current = undefined;
    };
  }, [accountVersion]);
  const processing = episodes.some(
    (item) => item.status === "queued" || item.status === "analyzing",
  );
  useEffect(() => {
    if (!user) return;
    let polling = false;
    const poll = async () => {
      if (document.hidden || polling) return;
      polling = true;
      try {
        await refresh();
      } catch {
      } finally {
        polling = false;
      }
    };
    const timer = processing
      ? window.setInterval(() => void poll(), 5000)
      : undefined;
    document.addEventListener("visibilitychange", poll);
    window.addEventListener("online", poll);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
      window.removeEventListener("online", poll);
    };
  }, [user?.id, processing]);
  useEffect(() => {
    if (
      !user ||
      !page ||
      player ||
      new URLSearchParams(location.search).has("episode")
    )
      return;
    const first = episodes.find(
      (item) => item.durationMs > 0 && item.status !== "blocked",
    );
    if (first) onOpen(first.id, false);
  }, [user?.id, page, episodes, player]);

  async function choose(file?: File, resumeId?: string) {
    if (!file || uploadBusy.current || !user) return;
    const owner = user.id;
    const epoch = ++uploadEpoch.current;
    const current = () => epoch === uploadEpoch.current;
    const abort = new AbortController();
    controller.current = abort;
    cancelRequested.current = false;
    uploadBusy.current = true;
    setError("");
    setUploadName(file.name);
    setChecking(true);
    setPhase("uploading");
    let uploadId = resumeId ?? "";
    try {
      if (file.size < 44 || file.size > MAX_UPLOAD_BYTES)
        throw Error(t("音频文件需小于 1 GiB"));
      const length = await inspectDuration(file);
      abort.signal.throwIfAborted();
      if (length !== null && length > MAX_AUDIO_DURATION_MS)
        throw Error(t("单个音频不能超过 5 小时"));
      setPhase("uploading");
      await episodeLibrary.upload(file, {
        owner,
        resumeId,
        title: fileTitle(file.name),
        signal: abort.signal,
        onStarted: (id) => {
          uploadId = id;
          if (!current()) return;
          lastFile.current = { id, file };
          setActiveUploadId(id);
          setChecking(false);
        },
        onProgress: (bytes, total, nextPhase) => {
          if (!current()) return;
          setChecking(false);
          setProgress(Math.round((bytes / total) * 100));
          setPhase(nextPhase);
        },
      });
      if (current()) {
        lastFile.current = null;
        await refresh();
      }
    } catch (cause) {
      if (!current()) return;
      if (abort.signal.aborted && cancelRequested.current && uploadId) {
        try {
          await episodeLibrary.cancelUpload(uploadId);
          forgetUpload(owner, uploadId);
          lastFile.current = null;
        } catch (cancelError) {
          cause = cancelError;
        }
      }
      if (!current()) return;
      setError(message(cause instanceof Error ? cause.message : String(cause)));
      if (uploadId) await refresh().catch(() => {});
    } finally {
      if (current()) {
        controller.current = null;
        uploadBusy.current = false;
        setChecking(false);
        setProgress(null);
        setActiveUploadId("");
        setUploadName("");
      }
    }
  }
  function resume(id: string) {
    if (uploadBusy.current) return;
    if (lastFile.current?.id === id) {
      void choose(lastFile.current.file, id);
      return;
    }
    resumeTarget.current = id;
    setError(t("请选择上次上传的同一个音频文件"));
    input.current?.click();
  }
  async function act(id: string, action: "retry" | "delete" | "cancel") {
    if (
      action === "delete" &&
      !window.confirm(t("确定删除这篇音频及其分析结果吗？"))
    )
      return;
    setBusyId(id);
    setError("");
    try {
      if (action === "retry") await episodeLibrary.retry(id);
      if (action === "delete") await episodeLibrary.delete(id);
      if (action === "cancel") {
        await episodeLibrary.cancelUpload(id);
        if (user) forgetUpload(user.id, id);
        if (lastFile.current?.id === id) lastFile.current = null;
      }
      if (action === "delete" && activeEpisodeId === id) {
        location.href = "/space";
        return;
      }
      await refresh();
    } catch (cause) {
      setError(message(cause instanceof Error ? cause.message : String(cause)));
    } finally {
      setBusyId("");
    }
  }
  async function more() {
    if (!page?.nextCursor || loadingMore) return;
    loadedPages.current++;
    setLoadingMore(true);
    try {
      await refresh();
    } catch (cause) {
      loadedPages.current--;
      throw cause;
    } finally {
      setLoadingMore(false);
    }
  }

  const navigation = (
    <>
      <a className="brand" href={homeHref()} aria-label="Aside">
        <span className="brand-word">Aside</span>
        <img
          className="brand-mark"
          src="/aside-mark.svg"
          alt=""
          aria-hidden="true"
        />
      </a>
      {user && (
        <LibraryDrawer
          collection="personal"
          publicHref={publicHref}
          label={t("我的音频")}
          onOpen={onOpen}
          items={[
            ...(page?.pending
              .filter((item) => item.id !== activeUploadId)
              .map((item) => ({
                id: item.id,
                title: item.title,
                meta: `${formatSize(item.size)} · ${t(readUpload(user.id, item.id) ? "上传中断，可继续上传" : "上传中断，可取消后重新上传")}`,
                actions: (
                  <>
                    {readUpload(user.id, item.id) && (
                      <button
                        disabled={
                          busyId === item.id ||
                          checking ||
                          progress !== null ||
                          !uploadEnabled
                        }
                        onClick={() => resume(item.id)}
                      >
                        {t("继续上传")}
                      </button>
                    )}
                    <button
                      disabled={busyId === item.id}
                      onClick={() => void act(item.id, "cancel")}
                    >
                      {t("取消")}
                    </button>
                  </>
                ),
              })) ?? []),
            ...episodes.map((item) => ({
              ...audioCard(item),
              actions: (
                <>
                  {item.status === "failed" && (
                    <button
                      disabled={busyId === item.id}
                      onClick={() => void act(item.id, "retry")}
                    >
                      {t("重试分析")}
                    </button>
                  )}
                  <button
                    disabled={busyId === item.id}
                    onClick={() => void act(item.id, "delete")}
                  >
                    {t("删除")}
                  </button>
                </>
              ),
            })),
          ]}
          footer={
            <>
              {" "}
              {page && !page.pending.length && !episodes.length && (
                <p className="space-sidebar-empty">
                  {t("这里还没有音频")}
                  <br />
                  {t("上传后会自动分析，无需再点开始。")}
                </p>
              )}
              {page?.nextCursor && (
                <button
                  className="space-more btn btn-secondary btn-sm"
                  disabled={loadingMore}
                  onClick={() =>
                    void more().catch((cause) =>
                      setError(message(cause.message)),
                    )
                  }
                >
                  {t("加载更多")}
                </button>
              )}
            </>
          }
        >
          <details className="space-upload-options">
            <summary>＋ {t("上传音频")}</summary>
            <button
              type="button"
              className="space-sidebar-upload btn btn-primary"
              disabled={
                !uploadEnabled ||
                !page ||
                checking ||
                progress !== null ||
                page.usedThisMonth >= page.monthlyLimit ||
                page.usedStorage >= page.storageLimit
              }
              onClick={() => {
                resumeTarget.current = undefined;
                input.current?.click();
              }}
              aria-describedby="space-upload-limit"
            >
              {t("选择音频")}
            </button>
            <input
              ref={input}
              type="file"
              accept="audio/*,.mp4"
              aria-label={t("选择音频")}
              className="space-sidebar-file"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                const resumeId = resumeTarget.current;
                resumeTarget.current = undefined;
                void choose(file, resumeId);
              }}
            />
            <p id="space-upload-limit" className="space-sidebar-limit">
              {page
                ? `${page.usedThisMonth} / ${page.monthlyLimit} ${t("篇本月已用")}`
                : t("正在加载…")}
              <span>
                {t("单个音频最长 5 小时 · 文件最大 1 GiB · 每月最多 100 篇")}
              </span>
            </p>
            {!uploadEnabled && (
              <p className="space-sidebar-note">
                {t("上传暂未开放，已保存的音频仍可收听。")}
              </p>
            )}
          </details>
          {(checking || progress !== null) && (
            <div className="space-upload-activity" role="status">
              <strong>{uploadName}</strong>
              <small>
                {checking
                  ? t("正在检查音频")
                  : phase === "processing"
                    ? t("上传完成，正在启动自动分析…")
                    : `${progress}%`}
              </small>
              {progress !== null && (
                <div
                  className="space-progress"
                  role="progressbar"
                  aria-valuenow={progress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <span style={{ width: `${progress}%` }} />
                </div>
              )}
              {(checking || progress !== null) && phase === "uploading" && (
                <button
                  type="button"
                  className="btn btn-quiet btn-sm"
                  onClick={() => {
                    cancelRequested.current = true;
                    controller.current?.abort(new Error(t("上传已取消")));
                  }}
                >
                  {t("取消上传")}
                </button>
              )}
            </div>
          )}
          {error && (
            <div role="alert" className="space-sidebar-alert">
              {error}
              <button
                type="button"
                className="btn btn-quiet btn-icon btn-sm"
                onClick={() => setError("")}
                aria-label={t("关闭")}
              >
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="m4 4 8 8M12 4l-8 8" />
                </svg>
              </button>
            </div>
          )}
        </LibraryDrawer>
      )}
    </>
  );
  return (
    <div
      className={`space-page without-sidebar${player ? " shell is-playing" : ""}`}
    >
      {player ? (
        player(navigation)
      ) : (
        <main className="space-main">
          <header className="space-nav player-header">
            <div className="player-navigation">{navigation}</div>
            <div className="player-header-actions">
              <LanguageSelect />
              {accountControl}
            </div>
          </header>
          {!user && error && (
            <div role="alert" className="space-alert">
              {error}
              <button
                className="btn btn-quiet btn-icon btn-sm"
                onClick={() => setError("")}
                aria-label={t("关闭")}
              >
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="m4 4 8 8M12 4l-8 8" />
                </svg>
              </button>
            </div>
          )}
          {user === undefined ? (
            <p>{t("正在加载…")}</p>
          ) : !user ? (
            <section className="space-empty">
              <h2>{t("登录后，把想听的音频放在这里。")}</h2>
              <p>{t("请从右上角登录，随时回来继续收听。")}</p>
            </section>
          ) : (
            <section className="space-stage-empty">
              <h1>{t("我的空间")}</h1>
              <p>{t("你的音频，你可以加入的对话。")}</p>
              <p>{t("从音频库上传一段，或先探索公共音频。")}</p>
              <a className="space-explore btn btn-secondary" href={publicHref}>
                {t("探索公共音频")}
              </a>
            </section>
          )}
        </main>
      )}
    </div>
  );
}
