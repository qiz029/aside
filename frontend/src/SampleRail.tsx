import { useEffect, useRef, useState } from "react";
import type { Episode } from "@aside/engine/core";
import { t, useLocale } from "./i18n";
import { episodeHref, languageBadge } from "./library-item";
import "./sample-rail.css";

export function SampleRail({
  episodes,
  onOpen,
  label,
  title,
}: {
  episodes: Episode[];
  onOpen: (id: string) => void;
  label: string;
  /** Collection heading; an untitled rail keeps crediting the publisher. */
  title?: string;
}) {
  const locale = useLocale();
  const rail = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  useEffect(() => {
    const element = rail.current!;
    const update = () =>
      setEdges({
        start: element.scrollLeft <= 2,
        end:
          element.scrollLeft + element.clientWidth >= element.scrollWidth - 2,
      });
    element.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => {
      element.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [episodes.length]);
  const move = (direction: number) => {
    const element = rail.current!;
    element.scrollBy({
      left: direction * element.clientWidth * 0.8,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  };
  return (
    <div className="sample-collection" role="group" aria-label={label}>
      {title && (
        <h3 className="sample-collection-title">
          {title}
          <span>{episodes.length}</span>
        </h3>
      )}
      <ul className="sample-rail" ref={rail}>
        {episodes.map((episode, index) => {
          const seconds = Math.floor(episode.durationMs / 1000);
          const duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
          return (
            <li key={episode.id}>
              <a
                className="sample-panel"
                href={episodeHref(episode.id)}
                aria-label={`${t("选择音频")} ${episode.title}`}
                onClick={(event) => {
                  // Modified clicks keep the real URL so it can be opened in a
                  // new tab; a plain click stays inside the player.
                  if (
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey ||
                    event.button !== 0
                  )
                    return;
                  event.preventDefault();
                  onOpen(episode.id);
                }}
              >
                <span className="sample-panel-meta">
                  <span>
                    {(title
                      ? episode.attribution?.author
                      : episode.attribution?.publisher) || "Aside"}
                  </span>
                  <span>
                    {[languageBadge(episode, locale), duration]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <span className="sample-panel-wave" aria-hidden="true">
                  {Array.from({ length: 36 }, (_, i) => (
                    <i
                      key={i}
                      style={{
                        height: `${8 + ((i * 13 + index * 11) % 42)}px`,
                        animationDelay: `${i * -0.12}s`,
                      }}
                    />
                  ))}
                </span>
                <strong>{episode.title}</strong>
                <span className="sample-panel-bottom">
                  <span>{t("听听，聊聊。")}</span>
                  <span className="sample-panel-play" aria-hidden="true">
                    <svg viewBox="0 0 16 16" fill="currentColor">
                      <path d="M5 3.5 12 8l-7 4.5Z" />
                    </svg>
                  </span>
                </span>
              </a>
            </li>
          );
        })}
      </ul>
      {/* A short collection fits the row, and two dead arrows say nothing. */}
      <div className="sample-rail-controls" hidden={edges.start && edges.end}>
        <button
          className="btn btn-neutral btn-icon btn-lg"
          disabled={edges.start}
          onClick={() => move(-1)}
          aria-label={t("上一组音频")}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M13 8H3M7 4 3 8l4 4" />
          </svg>
        </button>
        <button
          className="btn btn-neutral btn-icon btn-lg"
          disabled={edges.end}
          onClick={() => move(1)}
          aria-label={t("下一组音频")}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 8h10M9 4l4 4-4 4" />
          </svg>
        </button>
      </div>
    </div>
  );
}
