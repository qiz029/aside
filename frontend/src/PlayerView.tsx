import { PlaybackTimeline } from "./PlaybackTimeline";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { AccountControl, type User } from "./AccountControl";
import { LanguageSelect } from "./LanguageSelect";
import { SpeedSelect } from "./SpeedSelect";
import { Transcript } from "./Transcript";
import { VoiceDiagnostics } from "./VoiceDiagnostics";
import { VoiceActivity } from "./VoiceActivity";
import { message, resumeLabel, t } from "./i18n";
import { names, type PlayerController } from "./usePlayerController";

export const formatPlayerTime = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

const LIVE_STATUSES = ["connecting", "transcribing", "on"];

export function PlayerView({
  player,
  onAuthChanged,
  navigation,
}: {
  navigation?: ReactNode;
  player: PlayerController;
  onAuthChanged: () => Promise<void>;
}) {
  const {
    listeningMode,
    manualHeld,
    beginManual,
    endManual,
    followupMs,
    resumeSeconds,
    resumeHeld,
    holdResume,
    returnContext,
    latencies,
    episode,
    state,
    history,
    answerPreview,
    error,
    configured,
    liveStatus,
    question,
    busy,
    debug,
    events,
    sources,
    audio,
    seek,
    submitQuestion,
    metadataLoaded,
    audioTick,
    setPlaybackRate,
    playerConfig,
    executePlayerCommand,
    setError,
    setDebug,
    setQuestion,
    requestResume,
    listeningActive,
    startListening,
    stopListening,
    retry,
  } = player;
  const [chatUser, setChatUser] = useState<User | null>(null);
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  const newConversationButton = (
    <button
      className="btn btn-secondary btn-sm new-conversation"
      disabled={player.startingNewConversation}
      title={t("清空当前对话，保留播放进度")}
      onClick={() => {
        setMobileTab("chat");
        void player.newConversation();
      }}
    >
      {player.startingNewConversation ? t("正在开始新对话…") : t("新对话")}
    </button>
  );
  const [compactEpisode, setCompactEpisode] = useState("");
  const compact = !!episode && compactEpisode === episode.id;
  // A cover that fails to load falls back to the drawn art for that episode.
  const [brokenCover, setBrokenCover] = useState("");
  const showCover = !!episode?.cover && brokenCover !== episode.id;
  const panelId = useId();
  const audioPlaying = state.mode === "playing";
  // Aside is in the conversation from the interruption until playback is asked to resume.
  const agentPresent = !!state.interruption && !state.resumeRequested;
  const agentJoining =
    agentPresent && ["connecting", "transcribing"].includes(liveStatus);
  const agentSpeaking = state.mode === "answering";
  const [mobileTab, setMobileTab] = useState<"transcript" | "chat" | null>(
    "transcript",
  );
  useEffect(() => {
    if (state.interruption) setMobileTab("chat");
  }, [state.interruption]);
  useEffect(() => {
    if (listeningActive) setMobileTab("transcript");
  }, [listeningActive]);
  const layoutTransition = useRef<ViewTransition | undefined>(undefined);
  useEffect(() => {
    const target = listeningActive && episode ? episode.id : "";
    if (target === compactEpisode) return;
    layoutTransition.current?.skipTransition();
    const update = () => {
      if (target) window.scrollTo(0, 0);
      setCompactEpisode(target);
    };
    if (
      !document.startViewTransition ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      update();
      return;
    }
    layoutTransition.current = document.startViewTransition(() =>
      flushSync(update),
    );
    // Skips and browser animation timeouts reject ready even when React has
    // committed the new layout. Keep playback independent of that animation.
    const transition = layoutTransition.current;
    void transition.ready.catch(() => transition.skipTransition());
  }, [listeningActive, episode?.id, compactEpisode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.code !== "Space" ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.defaultPrevented
      )
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.closest(
            "input, textarea, select, button, a, summary, [role='button'], [role='textbox']",
          ))
      )
        return;
      if (!episode) return;
      event.preventDefault();
      if (event.repeat) return;
      if (listeningActive) stopListening();
      else startListening();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [episode, listeningActive, startListening, stopListening]);

  useEffect(() => {
    if (!manualHeld) return;
    const release = () => endManual();
    const hide = () => {
      if (document.hidden) release();
    };
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [manualHeld, endManual]);

  const messages = useRef<HTMLDivElement>(null);
  const debugAllowed =
    import.meta.env.DEV ||
    new URLSearchParams(window.location.search).has("debug");
  const debugOpen = debugAllowed && debug;
  useLayoutEffect(() => {
    const box = messages.current;
    if (!box) return;
    const scrollToBottom = () => {
      box.scrollTop = box.scrollHeight;
    };
    scrollToBottom();
    const resize = new ResizeObserver(scrollToBottom);
    resize.observe(box);
    return () => resize.disconnect();
  }, [history, answerPreview, busy, episode?.id, compact]);

  if (!episode) return null;
  return (
    <main
      className={`player-main${compact ? " listening-layout" : ""}${debugOpen ? " diagnostics-open" : ""}`}
    >
      {player.checkpointConflict && (
        <section role="alert" className="error">
          <p>{t("另一台设备更新了进度")}</p>
          <button onClick={player.keepLocalCheckpoint}>{t("继续本机")}</button>
          <button onClick={player.useRemoteCheckpoint}>
            {t("接着另一设备听")}
          </button>
        </section>
      )}
      <header className="player-header">
        <div className="player-navigation">
          {navigation ?? <span>{t("听到这里，你也有话想说。")}</span>}
        </div>
        <div className="player-header-actions">
          <LanguageSelect />
          <AccountControl
            onAuthChanged={onAuthChanged}
            onUserChanged={setChatUser}
          />
        </div>
      </header>
      {error && (
        <div role="alert" className="alert">
          <span className="alert-message">{message(error)}</span>
          {episode?.analysis &&
            (history.length > 0 || question.trim()) &&
            newConversationButton}
          <button
            className="btn btn-quiet btn-icon btn-sm"
            aria-label={t("关闭")}
            onClick={() => setError("")}
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
      <section className={`player-card${compact ? " compact" : ""}`}>
        <div className="cover">
          <span>ASIDE / AUDIO NOTES</span>
          <div className="cover-art">
            {Array.from({ length: 25 }, (_, i) => (
              <i
                key={i}
                style={{ height: 25 + Math.sin(i * 0.75) ** 2 * 100 }}
              />
            ))}
          </div>
          <em>{t("留白，也是对话。")}</em>
        </div>
        <div className="player-content">
          <div className="eyebrow">
            {episode.analysis?.source === "demo"
              ? t("本地演示 · 合成音频 / 预设分段")
              : t("正在收听")}
          </div>
          <h1>{episode.title}</h1>
          <p className="description">
            {episode.analysis
              ? episode.analysis.summary.slice(0, 130)
              : message(episode.stage)}
          </p>
          {episode.status !== "ready" && (
            <>
              <progress max={1} value={episode.progress} />
              <p>{message(episode.error ?? "")}</p>
              {["blocked", "failed"].includes(episode.status) && (
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => void retry().catch((e) => setError(e.message))}
                >
                  {t("重新分析")}
                </button>
              )}
            </>
          )}
          <div className="status">
            <span
              className={`dot ${state.mode === "playing" ? "green" : ""}`}
            />
            {t(names[state.mode])}
            {episode.analysis && (
              <span className="voice-label">
                {episode.analysis.voice === "feminine" ? t("女声") : t("男声")}{" "}
                {t("· 自动匹配")}
              </span>
            )}
          </div>
        </div>
      </section>
      {episode.attribution && (
        <div className="source-credit">
          <a
            href={episode.attribution.sourceUrl}
            target="_blank"
            rel="noreferrer"
          >
            {episode.attribution.publisher} · {episode.attribution.author} ↗
          </a>
          <span>{t("节选")}</span>
          <a
            href={episode.attribution.licenseUrl}
            target="_blank"
            rel="noreferrer"
          >
            {t("转载许可")} ↗
          </a>
          {episode.attribution.license.startsWith("CC BY") && (
            <>
              <span>{episode.attribution.license}</span>
              <a
                href={`/api/episodes/${episode.id}/audio`}
                download={`${episode.id}.mp3`}
              >
                {t("下载节选")}
              </a>
              <a
                href={`/api/episodes/${episode.id}`}
                download={`${episode.id}.json`}
              >
                {t("下载转写")}
              </a>
            </>
          )}
        </div>
      )}
      <audio
        key={episode.id}
        ref={audio}
        src={`/api/episodes/${episode.id}/audio`}
        onLoadedMetadata={metadataLoaded}
        onTimeUpdate={audioTick}
        onEnded={stopListening}
      />
      <VoiceActivity status={liveStatus} readLevel={player.microphoneLevel} />
      <div className="lower" hidden={debugOpen}>
        <section
          className="transcript"
          data-active={mobileTab === "transcript" || undefined}
        >
          <button
            className="mobile-panel-toggle"
            aria-expanded={mobileTab === "transcript"}
            aria-controls={`${panelId}-transcript`}
            onClick={() =>
              setMobileTab((current) =>
                current === "transcript" ? null : "transcript",
              )
            }
          >
            <span>{t("文字稿")}</span>
            <span aria-hidden="true">⌄</span>
          </button>
          <div className="mobile-panel-body" id={`${panelId}-transcript`}>
            <Transcript
              key={episode.id}
              passages={episode.analysis?.passages ?? []}
              session={player.session}
              onSeek={(atMs) => {
                seek(atMs);
                startListening();
              }}
            />
            {state.interruption && (
              <div className="return-note">
                <span>
                  {t("↶ 聊完从这里继续 ·")}
                  {formatPlayerTime(state.interruption.resumeMs)}
                </span>
                {returnContext && (
                  <p className="return-context">
                    {t("刚才听到：")}
                    {returnContext}
                  </p>
                )}
                <p>
                  {
                    episode.analysis?.anchors.find(
                      (a) => a.id === state.interruption?.anchorId,
                    )?.text
                  }
                </p>
              </div>
            )}
          </div>
        </section>
        <section
          className="conversation"
          data-active={mobileTab === "chat" || undefined}
        >
          <button
            className="mobile-panel-toggle"
            aria-expanded={mobileTab === "chat"}
            aria-controls={`${panelId}-chat`}
            onClick={() =>
              setMobileTab((current) => (current === "chat" ? null : "chat"))
            }
          >
            <span>{t("聊两句")}</span>
            <span aria-hidden="true">⌄</span>
          </button>
          <div className="mobile-panel-body" id={`${panelId}-chat`}>
            <div className="panel-heading conversation-heading">
              <h2>{t("聊两句")}</h2>
              {newConversationButton}
              <div className="conversation-microphone">
                <span
                  role="status"
                  className={liveStatus !== "off" ? "mic active" : "mic"}
                >
                  {{
                    off: t("麦克风未监听"),
                    arming: t("开启麦克风…"),
                    armed:
                      listeningMode === "manual"
                        ? t("按住说话 · 待命")
                        : t("● 本地监听"),
                    connecting: t("● Aside 正在加入"),
                    transcribing: t("● 正在识别"),
                    on:
                      listeningMode === "manual"
                        ? t("按住说话 · 可继续追问")
                        : t("● 语音交流中"),
                    closing: t("● 本地监听"),
                  }[liveStatus] ?? t("麦克风未监听")}
                </span>
              </div>
            </div>
            {state.interruption && (
              <p className="conversation-origin">
                {t("从 {time} 开始聊").replace(
                  "{time}",
                  formatPlayerTime(state.interruption.atMs),
                )}
              </p>
            )}
            <div
              className="messages"
              ref={messages}
              role="log"
              aria-label={t("对话记录")}
            >
              {!history.length ? (
                <div className="empty-chat">
                  <div className="waveform" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                  </div>
                  <p>
                    {t("一个问题、一点不同意见，")}
                    <br />
                    {t("或与你有关的经历，都可以从这里聊起。")}
                  </p>
                  <small>
                    {configured
                      ? listeningMode === "auto"
                        ? t("语音开启时保持实时连接，可用英语控制播放或提问。")
                        : listeningMode === "manual"
                          ? t("按住下方按钮说话，松开后回答。")
                          : t("安心听，也可以打字聊聊你的想法。")
                      : t("配置服务端 API key 后可语音或文字提问。")}
                  </small>
                </div>
              ) : (
                history.map((turn, i) => (
                  <div
                    key={i}
                    className={`message ${turn.role}${agentSpeaking && turn.role === "assistant" && i === history.length - 1 ? " is-speaking" : ""}`}
                  >
                    <span
                      className={`chat-avatar${turn.role === "user" && !chatUser ? " is-guest" : ""}`}
                      aria-hidden="true"
                    >
                      {turn.role === "assistant" ? (
                        <img src="/aside-mark.svg" alt="" />
                      ) : chatUser?.avatarUrl &&
                        failedAvatar !== chatUser.avatarUrl ? (
                        <img
                          src={chatUser.avatarUrl}
                          alt=""
                          onError={() => setFailedAvatar(chatUser.avatarUrl)}
                        />
                      ) : chatUser ? (
                        chatUser.alias.slice(0, 1).toUpperCase()
                      ) : (
                        <svg viewBox="0 0 24 24" fill="currentColor">
                          <circle cx="12" cy="8" r="4" />
                          <path d="M4 21v-2a8 8 0 0 1 16 0v2Z" />
                        </svg>
                      )}
                    </span>
                    <div className="message-content">
                      <small>
                        {turn.role === "user" ? t("你") : "Aside · AI"}
                      </small>
                      <p>{turn.text}</p>
                    </div>
                  </div>
                ))
              )}
              {answerPreview && (
                <div className="message assistant is-preview" aria-busy="true">
                  <span className="chat-avatar" aria-hidden="true">
                    <img src="/aside-mark.svg" alt="" />
                  </span>
                  <div className="message-content">
                    <small>Aside · AI</small>
                    <p>{answerPreview}</p>
                  </div>
                </div>
              )}
              {busy && !answerPreview && (
                <div className="busy">
                  {t("正在找相关材料")}
                  <span>…</span>
                </div>
              )}
            </div>
            {state.interruption && (
              <div className="followup-window">
                <span>
                  {resumeSeconds !== null
                    ? resumeLabel(resumeSeconds)
                    : resumeHeld || followupMs === 0
                      ? t("准备好了，再继续听")
                      : busy
                        ? t("聊完再接着听")
                        : t("可以追问，或继续听")}
                </span>
                {!resumeHeld && (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={holdResume}
                  >
                    {t("先别继续")}
                  </button>
                )}
              </div>
            )}
            {listeningMode === "manual" && (
              <button
                className={`push-to-talk${manualHeld ? " recording" : ""}`}
                disabled={!configured || !episode.analysis}
                aria-label={t("按住说话")}
                aria-pressed={manualHeld}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  e.currentTarget.focus();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  void beginManual();
                }}
                onPointerUp={endManual}
                onPointerCancel={endManual}
                onLostPointerCapture={endManual}
                onBlur={endManual}
                onContextMenu={(e) => e.preventDefault()}
                onKeyDown={(e) => {
                  if ((e.code === "Space" || e.code === "Enter") && !e.repeat) {
                    e.preventDefault();
                    void beginManual();
                  }
                }}
                onKeyUp={(e) => {
                  if (e.code === "Space" || e.code === "Enter") {
                    e.preventDefault();
                    endManual();
                  }
                }}
              >
                {manualHeld
                  ? liveStatus === "arming"
                    ? t("开启麦克风…就绪后说话")
                    : t("正在录音 · 松开发送")
                  : t("按住说话")}
              </button>
            )}
            <form
              className={
                LIVE_STATUSES.includes(liveStatus)
                  ? "composer is-listening"
                  : "composer"
              }
              onSubmit={(e) => {
                e.preventDefault();
                setMobileTab("chat");
                submitQuestion();
              }}
            >
              <input
                aria-label={t("输入消息")}
                placeholder={t("听到这里，你想说什么？")}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
              />
              <button
                className="btn btn-primary btn-icon"
                disabled={!configured || !episode.analysis || !question.trim()}
                aria-label={t("发送消息")}
              >
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M8 13V3M4 7l4-4 4 4" />
                </svg>
              </button>
            </form>
            {sources.length > 0 && (
              <details>
                <summary>
                  {t("参考材料 ·")}
                  {sources.length}
                </summary>
                {sources.map((s, i) => (
                  <p key={i}>
                    {s.url ? (
                      <a href={s.url} target="_blank" rel="noreferrer">
                        {s.text}
                      </a>
                    ) : (
                      `${formatPlayerTime(s.startMs ?? 0)} ${s.text}`
                    )}
                  </p>
                ))}
              </details>
            )}
          </div>
        </section>
      </div>
      <div className="player-dock" aria-label={t("播放控制")}>
        <div className="dock-title" title={episode.title}>
          <span
            className={`dock-art${audioPlaying ? " playing" : ""}${showCover ? " has-cover" : ""}`}
            aria-hidden="true"
          >
            {showCover && (
              <img
                src={`/api/episodes/${episode.id}/cover`}
                alt=""
                onError={() => setBrokenCover(episode.id)}
              />
            )}
          </span>
          <strong>{episode.title}</strong>
        </div>
        <div className="dock-transport">
          <PlaybackTimeline player={player} episode={episode} />
          <div className="controls">
            <button
              className={`play btn btn-primary btn-icon${listeningActive ? " playing" : ""}`}
              aria-keyshortcuts="Space"
              title={t("播放 / 暂停（空格）")}
              aria-label={listeningActive ? t("暂停") : t("播放")}
              onClick={listeningActive ? stopListening : startListening}
            >
              {listeningActive ? (
                <svg
                  viewBox="0 0 16 16"
                  width="15"
                  height="15"
                  aria-hidden="true"
                >
                  <rect
                    x="3"
                    y="2"
                    width="3.4"
                    height="12"
                    rx="1"
                    fill="currentColor"
                  />
                  <rect
                    x="9.6"
                    y="2"
                    width="3.4"
                    height="12"
                    rx="1"
                    fill="currentColor"
                  />
                </svg>
              ) : (
                <svg
                  viewBox="0 0 16 16"
                  width="15"
                  height="15"
                  aria-hidden="true"
                >
                  <path
                    d="M4.5 2.3c0-1 1.1-1.6 2-1.1l7.5 4.7c.8.5.8 1.7 0 2.2l-7.5 4.7c-.9.5-2-.1-2-1.1z"
                    fill="currentColor"
                  />
                </svg>
              )}
            </button>
            {state.interruption && (
              <button
                className="resume btn btn-secondary btn-sm"
                onClick={requestResume}
              >
                {t("继续听 ↗")}
              </button>
            )}
          </div>
        </div>
        <SpeedSelect config={playerConfig} onChange={setPlaybackRate} />
        <div className="dock-volume" role="group" aria-label={t("音量控制")}>
          <button
            type="button"
            className="volume-toggle btn btn-quiet btn-icon"
            aria-label={t("静音")}
            aria-pressed={playerConfig.muted}
            title={playerConfig.muted ? t("取消静音") : t("静音")}
            onClick={() =>
              executePlayerCommand({
                type: "set_muted",
                muted: !playerConfig.muted,
              })
            }
          >
            <svg
              viewBox="0 0 24 24"
              width="19"
              height="19"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M11 5 6 9H3v6h3l5 4V5Z" />
              {playerConfig.muted ? (
                <path d="m16 9 6 6m0-6-6 6" />
              ) : playerConfig.volume > 0 ? (
                <>
                  <path d="M15 9a5 5 0 0 1 0 6" />
                  {playerConfig.volume > 0.5 && (
                    <path d="M18 5a10 10 0 0 1 0 14" />
                  )}
                </>
              ) : null}
            </svg>
          </button>
          <input
            type="range"
            className="volume-slider"
            aria-label={t("播客音量")}
            aria-valuetext={`${Math.round(playerConfig.volume * 100)}%${playerConfig.muted ? ` · ${t("已静音")}` : ""}`}
            min={0}
            max={100}
            step={1}
            value={Math.round(playerConfig.volume * 100)}
            onChange={(e) =>
              executePlayerCommand({
                type: "set_volume",
                volume: Number(e.target.value) / 100,
              })
            }
          />
          <span className="volume-value" aria-hidden="true">
            {playerConfig.muted
              ? t("已静音")
              : `${Math.round(playerConfig.volume * 100)}%`}
          </span>
        </div>
      </div>
      <button
        className="debug-toggle"
        hidden={!debugAllowed}
        aria-expanded={debugOpen}
        aria-controls={`${panelId}-diagnostics`}
        onClick={() => setDebug(!debug)}
      >
        {t("开发观察")}
        {debug ? "−" : "+"}
      </button>
      {debugOpen && (
        <div className="debug-workspace" id={`${panelId}-diagnostics`}>
          <VoiceDiagnostics read={player.voiceDiagnostics} />
          <details className="debug-details">
            <summary>Player events</summary>
            <pre className="debug">
              {JSON.stringify(
                {
                  state,
                  voiceReason: episode.analysis?.voiceReason,
                  responseLatencies: latencies,
                  events,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </div>
      )}
      <footer className="player-footer">
        ASIDE <span>{t("随时聊两句，再接着听。")}</span>
      </footer>
    </main>
  );
}
