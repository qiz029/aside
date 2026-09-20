import { useEffect, useRef, type ReactNode } from "react";
import { groupByCollection, type Episode } from "@aside/engine/core";
import { homeHref, t, useLocale } from "./i18n";
import { HeroSoundscape } from "./HeroSoundscape";
import { ScrollStory } from "./ScrollStory";
import { LanguageSelect } from "./LanguageSelect";
import "./landing.css";
import { libraryFor } from "./library-item";
import { SampleRail } from "./SampleRail";

export function Landing({
  episodes,
  loading,
  open,
  error,
  accountControl,
  spaceLink,
}: {
  episodes: Episode[];
  loading: boolean;
  open: (id: string) => void;
  error: string;
  accountControl?: ReactNode;
  spaceLink?: boolean;
}) {
  const locale = useLocale();
  const rootRef = useRef<HTMLDivElement>(null);
  const ready = libraryFor(
    episodes.filter((episode) => episode.status === "ready"),
    locale,
  );
  const demo =
    (locale === "en"
      ? (ready.find((episode) => episode.id === "jfk-rice-moon") ??
        ready.find((episode) => episode.attribution?.language === "en"))
      : ready.find((episode) => episode.attribution?.language === locale)) ??
    ready.find((episode) => episode.id === "demo-natural-resume") ??
    ready[0];
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const targets = root.querySelectorAll("[data-reveal]:not(.revealed)");
    if (
      !("IntersectionObserver" in window) ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      targets.forEach((target) => target.classList.add("revealed"));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("revealed");
            observer.unobserve(entry.target);
          }
        }
      },
      { rootMargin: "0px 0px -64px 0px", threshold: 0 },
    );
    targets.forEach((target) => observer.observe(target));
    return () => observer.disconnect();
  }, [ready.length]);
  return (
    <div className="landing" ref={rootRef}>
      <header className="landing-nav">
        <a className="brand" href={homeHref()} aria-label="Aside">
          Aside
          <img
            className="brand-mark"
            src="/aside-mark.svg"
            alt=""
            aria-hidden="true"
          />
        </a>
        <div className="landing-nav-actions">
          <a className="btn btn-quiet" href="#how-it-works">
            {t("如何使用")}
          </a>
          {spaceLink && (
            <a className="btn btn-quiet" href="/space">
              {t("我的空间")}
            </a>
          )}
          <LanguageSelect />
        </div>
      </header>
      <main className="landing-main">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-atmosphere" aria-hidden="true">
            <span className="hero-orbit" />
            <span className="hero-orbit hero-orbit-inner" />
          </div>
          <HeroSoundscape />
          <div className="hero-copy">
            <p className="hero-eyebrow">
              <span />
              {t("让过去的声音，成为此刻的对话")}
            </p>
            <h1 id="hero-title">
              {t("对话发生过，")}
              <br />
              <em>{t("你依然可以加入。")}</em>
            </h1>
            <p className="hero-description">{t("让聆听，多一种可能。")}</p>
            <div className="hero-actions">
              <button
                className="hero-cta btn btn-primary btn-lg"
                disabled={!demo}
                onClick={() => demo && open(demo.id)}
              >
                <span className="btn-lead" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="currentColor">
                    <path d="M4 2.8c0-.8.9-1.3 1.6-.9l7.4 4.7a1 1 0 0 1 0 1.8l-7.4 4.7c-.7.4-1.6-.1-1.6-.9z" />
                  </svg>
                </span>
                {t("体验示例")}
              </button>
              {accountControl}
            </div>
            <a
              className="hero-note"
              href="https://www.producthunt.com/products/aside-7?utm_source=asidefm&utm_medium=hero"
              target="_blank"
              rel="noopener"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path
                  fillRule="evenodd"
                  d="M10 20a10 10 0 1 1 0-20 10 10 0 0 1 0 20zm1.33-10H8.5V7h2.83a1.5 1.5 0 0 1 0 3zm0-5H6.5v10h2v-3h2.83a3.5 3.5 0 1 0 0-7z"
                />
              </svg>
              {t("我们在 Product Hunt 上线了")}
              <span aria-hidden="true">↗</span>
            </a>
            {error && <p role="alert">{error}</p>}
          </div>
        </section>
        <ScrollStory />
        <section className="landing-library" aria-labelledby="sample-title">
          <HeroSoundscape variant="library" />
          <div className="library-intro" data-reveal>
            <span className="hero-eyebrow">{t("从这里开始")}</span>
            <h2 id="sample-title">{t("留几分钟，试着聊两句。")}</h2>
            <p>{t("挑一段感兴趣的，听到有想法时，就开口聊聊。")}</p>
          </div>
          <div className="sample-library" data-reveal>
            {loading && !episodes.length && !error ? (
              <>
                <div className="sample-skeleton" />
                <div className="sample-skeleton" />
                <div className="sample-skeleton" />
              </>
            ) : ready.length ? (
              groupByCollection(ready, locale).map((group) => (
                <SampleRail
                  key={group.id ?? ""}
                  episodes={group.episodes}
                  onOpen={open}
                  label={group.title ?? t("公共音频库")}
                  title={group.title}
                />
              ))
            ) : (
              <p className="sample-empty">{t("暂时没有可收听的示例。")}</p>
            )}
          </div>
        </section>
      </main>
      <footer className="landing-footer" data-reveal>
        <span>Aside</span>
        <p>{t("随时聊两句，再接着听。")}</p>
        <a href="#hero-title">{t("回到顶部")} ↑</a>
      </footer>
    </div>
  );
}
