import { useVirtualizer } from "@tanstack/react-virtual";
import type { ListeningSession } from "./listening-session";
import { t, useLocale } from "./i18n";
import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Passage } from "@aside/engine/core";

const time = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

export function Transcript({
  passages,
  session,
  onSeek,
}: {
  passages: Passage[];
  session: ListeningSession;
  onSeek: (atMs: number) => void;
}) {
  useLocale();
  const viewport = useRef<HTMLDivElement>(null);
  const activeLine = useRef<HTMLParagraphElement>(null);
  const [following, setFollowing] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const activeIndex = useSyncExternalStore(session.subscribe, () =>
    passages.findLastIndex(
      (p) => p.startMs <= session.getSnapshot().state.positionMs,
    ),
  );
  const virtual = passages.length > 200;
  const rows = useVirtualizer({
    count: passages.length,
    getScrollElement: () => viewport.current,
    estimateSize: () => 110,
    overscan: 8,
    enabled: virtual,
    getItemKey: (index) => passages[index].id,
  });
  const allRows = useMemo(
    () => passages.map((_, index) => ({ index, start: 0 })),
    [passages],
  );
  useEffect(() => {
    if (virtual) {
      if (following && activeIndex >= 0)
        rows.scrollToIndex(activeIndex, { align: "center" });
      return;
    }
    const box = viewport.current;
    const line = activeLine.current;
    if (!following || !box || !line) return;
    const boxRect = box.getBoundingClientRect();
    const lineRect = line.getBoundingClientRect();
    box.scrollTo({
      top:
        box.scrollTop +
        lineRect.top -
        boxRect.top -
        (box.clientHeight - lineRect.height) / 2,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  }, [activeIndex, following, virtual]);
  return (
    <>
      <div className="panel-heading">
        <h2>{t("文字稿")}</h2>
        {following ? (
          <span className="transcript-following">{t("跟随播放")}</span>
        ) : (
          <button
            className="transcript-follow btn btn-secondary btn-sm"
            onClick={() => setFollowing(true)}
          >
            {t("回到当前播放")}
          </button>
        )}
      </div>
      <div
        className="transcript-lyrics"
        ref={viewport}
        tabIndex={0}
        role="region"
        aria-label={t("文字稿")}
        onWheel={() => setFollowing(false)}
        onTouchStart={() => setFollowing(false)}
        onPointerDown={() => setFollowing(false)}
        onKeyDown={(e) => {
          if (
            [
              "ArrowUp",
              "ArrowDown",
              "PageUp",
              "PageDown",
              "Home",
              "End",
              " ",
            ].includes(e.key)
          )
            setFollowing(false);
        }}
      >
        {passages.length ? (
          <div
            style={
              virtual
                ? { height: rows.getTotalSize(), position: "relative" }
                : undefined
            }
          >
            {(virtual ? rows.getVirtualItems() : allRows).map((row) => {
              const i = row.index,
                p = passages[i];
              return (
                <p
                  key={p.id}
                  data-index={i}
                  ref={
                    virtual
                      ? rows.measureElement
                      : i === activeIndex
                        ? activeLine
                        : undefined
                  }
                  style={
                    virtual
                      ? {
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          transform: `translateY(${row.start}px)`,
                        }
                      : undefined
                  }
                  aria-current={i === activeIndex ? "true" : undefined}
                  className={`transcript-line${i === activeIndex ? " is-current" : i < activeIndex ? " is-past" : ""}${selectedId === p.id ? " is-selected" : ""}`}
                  onClick={() => setSelectedId(p.id)}
                >
                  <span className="transcript-cue">
                    <span className="transcript-time">{time(p.startMs)}</span>
                    <button
                      type="button"
                      className="transcript-jump"
                      aria-label={`${t("从这句播放")} ${time(p.startMs)}`}
                      title={`${t("从这句播放")} · ${time(p.startMs)}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedId(null);
                        setFollowing(true);
                        onSeek(p.startMs);
                      }}
                    >
                      <svg
                        viewBox="0 0 16 16"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <path d="M4.5 2.8c0-.8.9-1.3 1.6-.9l7 4.5a1 1 0 0 1 0 1.8l-7 4.5c-.7.4-1.6-.1-1.6-.9z" />
                      </svg>
                    </button>
                  </span>
                  <span>{p.text}</span>
                </p>
              );
            })}
          </div>
        ) : (
          <p className="transcript-empty">
            {t("音频分析完成后，逐字稿会出现在这里。")}
          </p>
        )}
      </div>
    </>
  );
}
