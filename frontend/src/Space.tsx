import { readUpload, forgetUpload } from "./resumable-upload";
import { LibraryDrawer } from "./LibraryDrawer";
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
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

function inspectDuration(
  file: File,
  signal: AbortSignal,
): Promise<number | null> {
  return new Promise((resolve) => {
    const audio = document.createElement("audio");
    const url = URL.createObjectURL(file);
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const aborted = () => finish(null);
    const timer = setTimeout(() => finish(null), 8000);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) {
      finish(null);
      return;
    }
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
  const [uploadEnabled, setUploadEnabled] = useState<boolean | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState("");
  const [uploadedId, setUploadedId] = useState("");
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
      .catch(() => setUploadEnabled(false));
  }, []);
  useEffect(() => {
    let active = true;
    setUser(undefined);
    setUploadedId("");
    setNotice("");
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
  const processing =
    episodes.some(
      (item) => item.status === "queued" || item.status === "analyzing",
    ) ||
    (!!uploadedId && !episodes.some((item) => item.id === uploadedId));
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
      uploadedId ||
      checking ||
      progress !== null ||
      new URLSearchParams(location.search).has("episode")
    )
      return;
    const first = episodes.find(
      (item) => item.durationMs > 0 && item.status !== "blocked",
    );
    if (first) onOpen(first.id, false);
  }, [user?.id, page, episodes, player, uploadedId, checking, progress]);

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
    setNotice("");
    setUploadedId("");
    setUploadName(file.name);
    setChecking(true);
    setPhase("uploading");
    let uploadId = resumeId ?? "";
    try {
      if (
        !file.type.startsWith("audio/") &&
        !/\.(mp3|m4a|mp4|wav|flac|ogg|oga|opus|aac|aiff|aif|webm)$/i.test(
          file.name,
        )
      )
        throw Error(t("请选择音频文件"));
      if (file.size < 44) throw Error(t("文件为空或不完整，请重新选择"));
      if (!resumeId && uploadUnavailable) throw Error(uploadUnavailable);
      if (file.size > MAX_UPLOAD_BYTES) throw Error(t("音频文件需小于 1 GiB"));
      const length = await inspectDuration(file, abort.signal);
      abort.signal.throwIfAborted();
      if (length !== null && length > MAX_AUDIO_DURATION_MS)
        throw Error(t("单个音频不能超过 5 小时"));
      setPhase("uploading");
      const uploaded = await episodeLibrary.upload(file, {
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
        setUploadedId(uploaded.id);
        await refresh().catch(() => {
          if (current()) setNotice(t("音频已保存，暂时无法刷新分析进度。"));
        });
      }
    } catch (cause) {
      if (!current()) return;
      let cancelled = abort.signal.aborted && cancelRequested.current;
      if (cancelled && uploadId) {
        try {
          await episodeLibrary.cancelUpload(uploadId);
          forgetUpload(owner, uploadId);
          lastFile.current = null;
        } catch (cancelError) {
          cause = cancelError;
          cancelled = false;
        }
      }
      if (!current()) return;
      if (cancelled) setNotice(t("上传已取消"));
      else
        setError(
          message(cause instanceof Error ? cause.message : String(cause)),
        );
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
    setError("");
    setNotice(t("请选择上次上传的同一个音频文件"));
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
      if ((action === "delete" || action === "cancel") && uploadedId === id)
        setUploadedId("");
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

  const uploadUnavailable =
    uploadEnabled === false
      ? t("上传暂未开放，已保存的音频仍可收听。")
      : page && page.usedThisMonth >= page.monthlyLimit
        ? t("本月上传额度已用完，下个月可继续上传。")
        : page && page.usedStorage >= page.storageLimit
          ? t("存储空间已满，删除不需要的音频后可继续上传。")
          : "";
  const uploadDisabled =
    !uploadEnabled ||
    !!uploadUnavailable ||
    !page ||
    checking ||
    progress !== null;
  const uploaded = episodes.find((item) => item.id === uploadedId);
  function pickFile() {
    resumeTarget.current = undefined;
    input.current?.click();
  }
  const dropHandlers = {
    onDragOver(event: DragEvent<HTMLElement>) {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = uploadDisabled ? "none" : "copy";
      if (!uploadDisabled) setDragging(true);
    },
    onDragLeave(event: DragEvent<HTMLElement>) {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null))
        setDragging(false);
    },
    onDrop(event: DragEvent<HTMLElement>) {
      event.preventDefault();
      setDragging(false);
      if (uploadDisabled) return;
      if (event.dataTransfer.files.length > 1) {
        setError(t("请一次上传一个音频文件"));
        return;
      }
      void choose(event.dataTransfer.files[0]);
    },
  };
  const feedback = (
    <>
      {(checking || progress !== null) && (
        <div className="space-upload-activity" role="status">
          <strong>{uploadName}</strong>
          <small>
            {checking
              ? t("正在检查音频")
              : phase === "processing"
                ? t("上传完成，正在启动自动分析…")
                : `${t("正在上传")} · ${progress ?? 0}%`}
          </small>
          {progress !== null && (
            <div
              className="space-progress"
              role="progressbar"
              aria-label={t("上传进度")}
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
      {uploadedId && (
        <div
          className="space-upload-activity space-upload-result"
          role="status"
        >
          {player && (
            <button
              type="button"
              className="space-upload-dismiss btn btn-quiet btn-icon btn-sm"
              aria-label={t("关闭")}
              onClick={() => setUploadedId("")}
            >
              ×
            </button>
          )}
          <strong>{uploaded?.title || t("音频已上传")}</strong>
          <small>
            {uploaded?.status === "ready"
              ? t("分析完成，可以开始收听和对话了。")
              : uploaded?.status === "failed" || uploaded?.status === "blocked"
                ? message(uploaded.error || uploaded.stage)
                : t("音频已保存，正在自动分析。你可以离开，稍后回来收听。")}
          </small>
          {uploaded?.status === "analyzing" && (
            <progress
              max={100}
              value={Math.round(uploaded.progress * 100)}
              aria-label={t("分析进度")}
            />
          )}
          {uploaded && audioCard(uploaded).canOpen && (
            <button
              className="btn btn-primary btn-sm"
              onClick={(event) => {
                event.currentTarget
                  .closest<HTMLDialogElement>("dialog")
                  ?.close();
                setUploadedId("");
                onOpen(uploaded.id);
              }}
            >
              {t("开始收听")}
            </button>
          )}
          {uploaded?.status === "failed" && (
            <button
              className="btn btn-secondary btn-sm"
              disabled={busyId === uploaded.id}
              onClick={() => void act(uploaded.id, "retry")}
            >
              {t("重试分析")}
            </button>
          )}
        </div>
      )}
      {notice && (
        <p className="space-upload-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <div role="alert" className="space-sidebar-alert">
          <span>
            {error}
            {lastFile.current && (
              <button
                className="btn btn-secondary btn-sm"
                disabled={checking || progress !== null}
                onClick={() => resume(lastFile.current!.id)}
              >
                {t("继续上传")}
              </button>
            )}
          </span>
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
    </>
  );

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
          onOpenChange={setLibraryOpen}
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
          <div className="space-upload-options" {...dropHandlers}>
            <button
              type="button"
              className="space-sidebar-upload btn btn-primary"
              disabled={uploadDisabled}
              onClick={pickFile}
              aria-describedby="space-upload-limit"
            >
              ＋ {t("上传音频")}
            </button>
            <p id="space-upload-limit" className="space-sidebar-limit">
              {page
                ? `${page.usedThisMonth} / ${page.monthlyLimit} ${t("篇本月已用")}`
                : t("正在加载…")}
              <span>
                {t("单个音频最长 5 小时 · 文件最大 1 GiB · 每月最多 100 篇")}
              </span>
            </p>
            {uploadUnavailable && (
              <p className="space-sidebar-note">{uploadUnavailable}</p>
            )}
          </div>
          {(player || libraryOpen) && feedback}
        </LibraryDrawer>
      )}
    </>
  );
  return (
    <div
      className={`space-page without-sidebar${player ? " shell is-playing" : ""}`}
    >
      <input
        ref={input}
        hidden
        type="file"
        accept="audio/*,.mp4,.m4a,.flac,.opus,.aiff,.webm"
        aria-label={t("选择音频")}
        className="space-sidebar-file"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          const resumeId = resumeTarget.current;
          resumeTarget.current = undefined;
          void choose(file, resumeId);
        }}
      />
      {player && !libraryOpen && (
        <div className="space-mobile-feedback">{feedback}</div>
      )}
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
              <div
                className={`space-dropzone${dragging ? " is-dragging" : ""}`}
                {...dropHandlers}
              >
                <svg
                  viewBox="0 0 32 32"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M16 21V5m-6 6 6-6 6 6M6 21v5a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5" />
                </svg>
                <h2>{t("拖入音频，或选择文件")}</h2>
                <p>{t("上传后会自动分析，无需再点开始。")}</p>
                <button
                  className="btn btn-primary"
                  disabled={uploadDisabled}
                  onClick={pickFile}
                >
                  {t("选择音频")}
                </button>
                <small>{t("最长 5 小时 · 最大 1 GiB")}</small>
                {uploadUnavailable && (
                  <p className="space-sidebar-note">{uploadUnavailable}</p>
                )}
              </div>
              {!libraryOpen && (
                <div className="space-stage-feedback">{feedback}</div>
              )}
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
