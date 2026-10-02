import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PodcastShow, PodcastEpisode } from "@aside/engine/contracts";
import { PodcastDiscovery as Controller } from "@aside/player-runtime/podcast-discovery";
import { podcastDirectory } from "./player-api";
import { useLocale } from "./i18n";
import "./podcasts.css";
export function PodcastDiscovery({
  onOpen,
}: {
  onOpen(id: string, userInitiated?: boolean, positionMs?: number): void;
}) {
  const mounted = useRef(true);
  const locale = useLocale(),
    tr = (zh: string, en: string) => (locale === "zh" ? zh : en);
  const [controller] = useState(() => new Controller(podcastDirectory));
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [query, setQuery] = useState(""),
    [url, setUrl] = useState("");
  const [country, setCountry] = useState(locale === "zh" ? "CN" : "US");
  const [opening, setOpening] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    mounted.current = true;
    void controller.refresh();
    return () => {
      mounted.current = false;
      controller.dispose();
    };
  }, [controller]);
  async function play(
    selection: Parameters<typeof podcastDirectory.importPodcast>[0],
  ) {
    if (opening) return;
    setOpening(true);
    setError("");
    try {
      const result = await podcastDirectory.importPodcast(selection);
      if (!mounted.current) return;
      onOpen(result.episode.id, true, result.positionMs || undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(false);
    }
  }
  function episode(show: PodcastShow, item: PodcastEpisode) {
    return (
      <li key={`${show.id}:${item.guid}`} className="podcast-episode">
        <div>
          <strong>{item.title}</strong>
          <small>
            {show.title}
            {item.publishedAt
              ? ` · ${new Date(item.publishedAt).toLocaleDateString()}`
              : ""}
            {item.durationMs
              ? ` · ${Math.round(item.durationMs / 60000)} min`
              : ""}
          </small>
          {state.show && <p>{item.description}</p>}
        </div>
        <button
          className="btn btn-secondary"
          disabled={opening}
          onClick={() =>
            void play({
              showId: show.id,
              country: show.country,
              guid: item.guid,
            })
          }
        >
          {tr("收听", "Listen")}
        </button>
      </li>
    );
  }
  return (
    <section
      className="podcast-discovery"
      aria-label={tr("找播客", "Find podcasts")}
    >
      <h2>{tr("想听什么？", "What would you like to hear?")}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void play({ url: url.trim() });
        }}
        className="podcast-form"
      >
        <input
          type="url"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-label={tr("播客单集链接", "Podcast episode link")}
          placeholder={tr(
            "粘贴 Apple Podcasts 单集链接",
            "Paste an Apple Podcasts episode link",
          )}
        />
        <button className="btn btn-primary" disabled={opening || !url.trim()}>
          {opening ? tr("正在打开…", "Opening…") : tr("直接收听", "Listen now")}
        </button>
      </form>
      <p className="podcast-hint">
        {tr(
          "无需下载文件。也可以搜索节目，订阅后在这里查看新单集。",
          "No file downloads needed. Search for a show and subscribe to see new episodes here.",
        )}
      </p>
      <form
        className="podcast-form"
        onSubmit={(e) => {
          e.preventDefault();
          void controller.search(query, country);
        }}
      >
        <input
          type="search"
          required
          minLength={2}
          maxLength={120}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={tr("搜索播客", "Search podcasts")}
          placeholder={tr("节目名或关键词", "Show name or keyword")}
        />
        <select
          aria-label={tr("节目地区", "Directory region")}
          value={country}
          onChange={(e) => setCountry(e.target.value)}
        >
          <option value="CN">中国</option>
          <option value="US">US</option>
          <option value="GB">UK</option>
          <option value="TW">台灣</option>
          <option value="HK">香港</option>
        </select>
        <button
          className="btn btn-secondary"
          disabled={state.busy || query.trim().length < 2}
        >
          {tr("搜索", "Search")}
        </button>
      </form>
      {(error || state.error) && <p role="alert">{error || state.error}</p>}
      {state.busy && <p role="status">{tr("正在加载…", "Loading…")}</p>}
      {state.show ? (
        <>
          <button className="btn btn-quiet" onClick={() => controller.back()}>
            {tr("返回", "Back")}
          </button>
          <div className="podcast-show-heading">
            <h3>{state.show.show.title}</h3>
            <button
              className="btn btn-secondary"
              disabled={state.busy}
              onClick={() => void controller.toggle(state.show!.show)}
            >
              {state.subscriptions.subscriptions.some(
                (s) => s.show.id === state.show!.show.id,
              )
                ? tr("取消订阅", "Unsubscribe")
                : tr("订阅", "Subscribe")}
            </button>
          </div>
          <p>{state.show.show.author}</p>
          {state.show.stale && (
            <p>
              {tr(
                "暂时无法更新，显示上次保存的单集。",
                "Showing saved episodes; updates are temporarily unavailable.",
              )}
            </p>
          )}
          <ul className="podcast-list">
            {state.show.episodes.map((item) => episode(state.show!.show, item))}
          </ul>
          {!state.show.episodes.length && (
            <p>{tr("暂无公开单集", "No public episodes available")}</p>
          )}
        </>
      ) : (
        <>
          {state.searched && (
            <>
              <h3>{tr("搜索结果", "Search results")}</h3>
              <ul className="podcast-list">
                {state.results.map((show) => (
                  <li key={show.id}>
                    <button
                      className="podcast-show"
                      onClick={() => void controller.open(show)}
                    >
                      {show.artworkUrl && (
                        <img src={show.artworkUrl} alt="" loading="lazy" />
                      )}
                      <span>
                        <strong>{show.title}</strong>
                        <small>{show.author}</small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {!state.busy && !state.results.length && (
                <p>
                  {tr(
                    "没有找到节目，试试其他关键词或地区。",
                    "No shows found. Try another keyword or region.",
                  )}
                </p>
              )}
            </>
          )}
          <div className="podcast-show-heading">
            <h3>{tr("我的订阅", "My subscriptions")}</h3>
            <button
              className="btn btn-quiet"
              disabled={state.busy}
              onClick={() => void controller.refresh()}
            >
              {tr("刷新列表", "Refresh list")}
            </button>
          </div>
          <div className="podcast-subscriptions">
            {state.subscriptions.subscriptions.map(({ show, stale }) => (
              <button
                key={show.id}
                className="btn btn-secondary"
                onClick={() => void controller.open(show)}
              >
                {show.title}
                {stale ? " · ↻" : ""}
              </button>
            ))}
          </div>
          {!state.subscriptions.subscriptions.length && (
            <p>
              {tr(
                "订阅喜欢的节目，新单集会自动出现在这里。",
                "Subscribe to a show to see its latest episodes here.",
              )}
            </p>
          )}
          <ul className="podcast-list">
            {state.subscriptions.episodes.map(({ show, episode: item }) =>
              episode(show, item),
            )}
          </ul>
        </>
      )}
    </section>
  );
}
