import type { Episode } from "./core.js";

export interface EpisodeGroup {
  /** Absent for recordings that name no collection, such as a listener's uploads. */
  id?: string;
  title?: string;
  episodes: Episode[];
}

/**
 * Splits a library into its collections for every client that lists one. The
 * incoming order is kept: a collection sits where its first recording was, so
 * whatever ordering the caller applied (interface language first) also orders
 * the shelves. Recordings without a collection share one untitled group.
 */
export function groupByCollection(
  episodes: Episode[],
  locale: string,
): EpisodeGroup[] {
  const language = locale.toLowerCase().split(/[-_]/)[0]!;
  const groups = new Map<string, EpisodeGroup>();
  for (const episode of episodes) {
    const collection = episode.attribution?.collection;
    // Library data is also written by hand, so a malformed entry is listed
    // without a shelf rather than taking the page down.
    const id = typeof collection?.id === "string" ? collection.id : "";
    let group = groups.get(id);
    if (!group) {
      const title = id
        ? collection?.title?.[language] || collection?.title?.en || id
        : undefined;
      group = id ? { id, title, episodes: [] } : { episodes: [] };
      groups.set(id, group);
    }
    group.episodes.push(episode);
  }
  return [...groups.values()];
}
