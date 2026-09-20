import { useId, useRef, useState, useEffect, type ReactNode } from "react";
import type { AudioLibraryItem } from "./library-item";
import { homeHref, t } from "./i18n";
import "./library-drawer.css";

// Long titles rest on an ellipsis and only scroll while their row is hovered or focused.
function LibraryTitle({ title, scroll }: { title: string; scroll: boolean }) {
  const viewport = useRef<HTMLElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const [engaged, setEngaged] = useState(false);
  useEffect(() => {
    const row = viewport.current!.closest(".audio-library-select");
    if (!row) return;
    const on = () => setEngaged(true);
    const off = () => setEngaged(false);
    row.addEventListener("pointerenter", on);
    row.addEventListener("pointerleave", off);
    row.addEventListener("focus", on);
    row.addEventListener("blur", off);
    return () => {
      row.removeEventListener("pointerenter", on);
      row.removeEventListener("pointerleave", off);
      row.removeEventListener("focus", on);
      row.removeEventListener("blur", off);
    };
  }, []);
  useEffect(() => {
    const container = viewport.current!;
    const label = text.current!;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let animation: Animation | undefined;
    const update = () => {
      animation?.cancel();
      container.classList.remove("is-scrolling");
      const distance = container.scrollWidth - container.clientWidth;
      if (!scroll || !engaged || reduced.matches || distance <= 1) return;
      container.classList.add("is-scrolling");
      const travel = Math.max(1800, (distance / 28) * 1000);
      const duration = 1800 + travel + 1600;
      animation = label.animate(
        [
          { transform: "translateX(0)", offset: 0 },
          { transform: "translateX(0)", offset: 1800 / duration },
          {
            transform: `translateX(-${distance}px)`,
            offset: (1800 + travel) / duration,
          },
          { transform: `translateX(-${distance}px)`, offset: 1 },
        ],
        { duration, iterations: Infinity, easing: "linear" },
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(container);
    observer.observe(label);
    reduced.addEventListener("change", update);
    update();
    return () => {
      animation?.cancel();
      container.classList.remove("is-scrolling");
      observer.disconnect();
      reduced.removeEventListener("change", update);
    };
  }, [title, scroll, engaged]);
  return (
    <strong ref={viewport} className="library-title">
      <span ref={text}>{title}</span>
    </strong>
  );
}

const COLLAPSED_KEY = "aside.library.collapsed";

/** Folded collections are a reader's own tidying, so they outlive the page. */
function savedCollapsed(): Set<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY)!);
    return new Set(Array.isArray(saved) ? saved.map(String) : []);
  } catch {
    return new Set();
  }
}

export function LibraryDrawer({
  items,
  label,
  onOpen,
  children,
  footer,
  collection,
  publicHref = homeHref(),
}: {
  items: AudioLibraryItem[];
  label: string;
  onOpen: (id: string) => void;
  children?: ReactNode;
  footer?: ReactNode;
  collection?: "public" | "personal";
  publicHref?: string;
}) {
  const sidebar = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(256);
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const maximum = Math.floor(viewportWidth / 2);
  const actualWidth = Math.max(220, Math.min(width, maximum));
  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const [desktop, setDesktop] = useState(
    () => window.matchMedia("(min-width: 1001px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1001px)");
    const update = () => {
      dialog.current?.close();
      setOpened(false);
      setDesktop(media.matches);
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const shell = sidebar.current?.closest<HTMLElement>(".without-sidebar");
    if (!desktop || !shell) return;
    shell.style.setProperty("--library-width", `${actualWidth}px`);
    return () => {
      shell.style.removeProperty("--library-width");
    };
  }, [desktop, actualWidth]);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [opened, setOpened] = useState(false);
  const titleId = useId();
  const dialogId = useId();
  function close() {
    dialog.current?.close();
  }
  const [collapsed, setCollapsed] = useState(savedCollapsed);
  function toggleGroup(id: string) {
    const next = new Set(collapsed);
    if (!next.delete(id)) next.add(id);
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
    } catch {
      // Private windows may refuse storage; the fold still works for this visit.
    }
  }
  const content = (
    <>
      {collection && (
        <nav className="library-collections" aria-label={t("音频库")}>
          <a
            href={publicHref}
            aria-current={collection === "public" ? "page" : undefined}
          >
            {t("公共音频")}
          </a>
          <a
            href="/space"
            aria-current={collection === "personal" ? "page" : undefined}
          >
            {t("我的音频")}
          </a>
        </nav>
      )}
      {children}
      <ul className="audio-library-list">
        {items.flatMap((item, index) => [
          item.group && item.group.id !== items[index - 1]?.group?.id && (
            <li
              key={`group:${item.group.id}`}
              className="audio-library-heading"
            >
              <h3>
                <button
                  aria-expanded={!collapsed.has(item.group.id)}
                  onClick={() => toggleGroup(item.group!.id)}
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
                    <path d="m6 4 4 4-4 4" />
                  </svg>
                  <span>{item.group.title}</span>
                  <small>
                    {
                      items.filter(
                        (other) => other.group?.id === item.group!.id,
                      ).length
                    }
                  </small>
                </button>
              </h3>
            </li>
          ),
          <li
            key={item.id}
            hidden={!!item.group && collapsed.has(item.group.id)}
            className={`audio-library-item${!item.canOpen ? " is-processing" : ""}`}
          >
            <button
              className="audio-library-select"
              title={item.title}
              disabled={!item.canOpen}
              onClick={() => {
                onOpen(item.id);
                close();
              }}
              aria-label={`${t("选择音频")} ${item.title}`}
            >
              <span className="audio-library-icon" aria-hidden="true">
                <span className="audio-library-duration">
                  {item.duration ?? "—"}
                </span>
                <svg
                  className="audio-library-play"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                >
                  <path d="M5 3.5a.7.7 0 0 1 1.05-.6l7 4.5a.7.7 0 0 1 0 1.2l-7 4.5A.7.7 0 0 1 5 12.5Z" />
                </svg>
              </span>
              <span>
                <LibraryTitle title={item.title} scroll={desktop} />
                <small>{item.meta}</small>
              </span>
            </button>
            {item.progress !== undefined && (
              <progress
                max={100}
                value={item.progress}
                aria-label={t("分析进度")}
              />
            )}
            {item.actions && (
              <details
                className="audio-library-menu"
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget))
                    event.currentTarget.open = false;
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    event.currentTarget.open = false;
                    event.currentTarget.querySelector("summary")?.focus();
                  }
                }}
              >
                <summary aria-label={`${t("音频操作")} ${item.title}`}>
                  ⋯
                </summary>
                <div className="audio-library-actions">{item.actions}</div>
              </details>
            )}
          </li>,
        ])}
      </ul>
      {footer}
    </>
  );
  if (desktop)
    return (
      <aside ref={sidebar} className="persistent-library" aria-label={label}>
        <div className="persistent-library-brand">
          <a className="brand" href={homeHref()} aria-label="Aside">
            <span className="brand-word">Aside</span>
            <img
              className="brand-mark"
              src="/aside-mark.svg"
              alt=""
              aria-hidden="true"
            />
          </a>
        </div>
        <header className="persistent-library-header">
          <h2 id={titleId}>{t("音频库")}</h2>
        </header>
        <div className="library-drawer-content">{content}</div>
        <div
          className="library-resize-handle"
          role="separator"
          tabIndex={0}
          aria-label={t("调整音频库宽度")}
          aria-orientation="vertical"
          aria-valuemin={220}
          aria-valuemax={maximum}
          aria-valuenow={actualWidth}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { x: event.clientX, width: actualWidth };
          }}
          onPointerMove={(event) => {
            if (!drag.current) return;
            setWidth(
              Math.max(
                220,
                Math.min(
                  maximum,
                  drag.current.width + event.clientX - drag.current.x,
                ),
              ),
            );
          }}
          onPointerUp={(event) => {
            drag.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onLostPointerCapture={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onDoubleClick={() => setWidth(256)}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            setWidth(
              event.key === "Home"
                ? 220
                : event.key === "End"
                  ? maximum
                  : Math.max(
                      220,
                      Math.min(
                        maximum,
                        actualWidth + (event.key === "ArrowRight" ? 16 : -16),
                      ),
                    ),
            );
          }}
        />
      </aside>
    );
  return (
    <>
      <button
        ref={trigger}
        className="library-trigger btn btn-secondary"
        aria-haspopup="dialog"
        aria-expanded={opened}
        aria-controls={dialogId}
        onClick={() => {
          dialog.current?.showModal();
          setOpened(true);
        }}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M3 4h10M3 8h10M3 12h6" />
        </svg>
        {t("音频库")}
      </button>
      <dialog
        ref={dialog}
        id={dialogId}
        className="library-drawer"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), a[href], summary, input:not(:disabled):not([type="file"]), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
            ),
          ).filter(
            (element) =>
              element.tabIndex >= 0 && element.getClientRects().length > 0,
          );
          const first = controls[0];
          const last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
        onClose={() => {
          setOpened(false);
          trigger.current?.focus();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <div className="library-drawer-panel">
          <header className="library-drawer-header">
            <h2 id={titleId}>{label}</h2>
            <button
              className="btn btn-quiet btn-icon"
              autoFocus
              onClick={close}
              aria-label={t("关闭音频库")}
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
          </header>
          <div className="library-drawer-content">{content}</div>
        </div>
      </dialog>
    </>
  );
}
