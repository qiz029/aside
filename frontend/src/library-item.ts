import type { ReactNode } from "react";
import { groupByCollection, type Episode } from "@aside/engine/core";
import { getLocale, message, t, translate, type Locale } from "./i18n";

export interface AudioLibraryItem {
  id: string;
  title: string;
  meta: string;
  /** Collection; the list prints its title once, above the first of its items. */
  group?: { id: string; title: string };
  duration?: string;
  description?: string;
  canOpen?: boolean;
  progress?: number;
  actions?: ReactNode;
}
/**
 * Attribution language is free-form data, so compare and label on the primary
 * subtag: an episode tagged `zh-CN` is still Chinese for a `zh` interface.
 */
export function primaryLanguage(language: string | undefined) {
  return language?.toLowerCase().split(/[-_]/)[0] || undefined;
}

/** Names the recording's language when it is not the interface language. */
export function languageBadge(
  episode: Episode,
  locale: Locale,
): string | undefined {
  const language = episode.attribution?.language;
  const code = primaryLanguage(language);
  if (!code || code === locale) return undefined;
  const name = code === "zh" ? "中文" : code === "en" ? "英文" : language!;
  return translate(name, locale);
}

/**
 * Puts recordings in the reader's own language first and leaves the rest in the
 * order they arrived. The public library holds more than one language, so the
 * interface language decides only the order, never what is available.
 */
export function byLocale(episodes: Episode[], locale: Locale): Episode[] {
  const rank = (episode: Episode) =>
    primaryLanguage(episode.attribution?.language) === locale ? 0 : 1;
  return episodes
    .map((episode, index) => ({ episode, index }))
    .sort((a, b) => rank(a.episode) - rank(b.episode) || a.index - b.index)
    .map((entry) => entry.episode);
}

/**
 * `languageVisibility` lists the interface languages a public recording is
 * published on. Entries are free-form, so `zh-cn` counts as `zh`. A recording
 * without the field stays visible everywhere: the filter exists for the
 * curated library, and a listener's own uploads must never disappear from
 * their own player.
 */
export function visibleForLocale(episode: Episode, locale: Locale): boolean {
  // Library data is written by hand as well as by the preparation script, so a
  // stray string where a list belongs must not take the page down.
  const visibility: unknown = episode.attribution?.languageVisibility;
  if (!Array.isArray(visibility) || !visibility.length) return true;
  return visibility.some((code) => primaryLanguage(String(code)) === locale);
}

/** What a reader sees: their own language's recordings first, nothing hidden. */
export function libraryFor(episodes: Episode[], locale: Locale): Episode[] {
  return byLocale(
    episodes.filter((episode) => visibleForLocale(episode, locale)),
    locale,
  );
}

/** Public, indexable URL of one recording; the Worker serves a page there. */
export function episodeHref(id: string) {
  return `/episodes/${encodeURIComponent(id)}`;
}

/**
 * The public library as list rows, collection by collection. Grouping happens
 * after `libraryFor`, so the reader's own language still leads.
 */
export function libraryCards(
  episodes: Episode[],
  locale: Locale,
): AudioLibraryItem[] {
  const groups = groupByCollection(libraryFor(episodes, locale), locale);
  // Beside titled collections, loose recordings need a heading of their own:
  // without one they read as part of whichever collection precedes them,
  // above all when that collection is folded.
  const other = groups.some((group) => group.id)
    ? { id: "", title: translate("其他", locale) }
    : undefined;
  return groups.flatMap((group) =>
    group.episodes.map((episode) =>
      group.id
        ? audioCard(episode, { id: group.id, title: group.title! })
        : { ...audioCard(episode), group: other },
    ),
  );
}

export function audioCard(
  episode: Episode,
  group?: AudioLibraryItem["group"],
): AudioLibraryItem {
  const seconds = Math.floor(episode.durationMs / 1000);
  return {
    id: episode.id,
    title: episode.title,
    group,
    duration: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`,
    meta: [
      // Under a collection heading the speaker tells items apart; the
      // publisher would repeat on every row.
      group ? episode.attribution?.author : episode.attribution?.publisher,
      languageBadge(episode, getLocale()),
      `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`,
      episode.status === "ready"
        ? t("可对话")
        : message(episode.error || episode.stage),
    ]
      .filter(Boolean)
      .join(" · "),
    description: episode.analysis?.summary,
    canOpen: episode.durationMs > 0 && episode.status !== "blocked",
    progress:
      episode.status === "analyzing"
        ? Math.round(episode.progress * 100)
        : undefined,
  };
}
