import { z } from "zod";
import type { Episode } from "@aside/engine/core";
import { MAX_AUDIO_DURATION_MS } from "@aside/engine/core";
import type { PodcastShow, PodcastEpisode } from "@aside/engine/contracts";
import { boundedBody, publicFetch, publicUrl } from "./public-fetch.js";
import { parseFeed, PodcastImportError } from "./podcast-import.js";

export const podcastCountrySchema = z
  .string()
  .regex(/^[a-zA-Z]{2}$/)
  .transform((v) => v.toUpperCase());
export const podcastIdSchema = z.string().regex(/^\d{1,20}$/);
export const podcastSelectionSchema = z.union([
  z.object({ url: z.string().url().max(4096) }),
  z.object({
    showId: podcastIdSchema,
    country: podcastCountrySchema.default("US"),
    guid: z.string().min(1).max(4096),
  }),
]);
function optionalUrl(value: unknown) {
  if (typeof value !== "string") return undefined;
  try {
    return publicUrl(value).href;
  } catch {
    return undefined;
  }
}
function showFromRecord(
  record: Record<string, unknown>,
  country: string,
): PodcastShow | undefined {
  const id = String(record.collectionId ?? "");
  const feedUrl = optionalUrl(record.feedUrl);
  if (
    !/^\d{1,20}$/.test(id) ||
    !feedUrl ||
    typeof record.collectionName !== "string"
  )
    return;
  return {
    id,
    country,
    feedUrl,
    title: record.collectionName.slice(0, 300),
    author: String(record.artistName ?? "").slice(0, 300),
    sourceUrl: `https://podcasts.apple.com/${country.toLowerCase()}/podcast/id${id}`,
    artworkUrl: optionalUrl(record.artworkUrl600 ?? record.artworkUrl100),
  };
}
async function appleRecords(url: string, request: typeof publicFetch) {
  const response = await request(url);
  const data = JSON.parse(
    new TextDecoder().decode(await boundedBody(response, 4 * 1024 * 1024)),
  );
  if (!Array.isArray(data.results))
    throw new PodcastImportError(
      "节目目录暂不可用 / Podcast directory unavailable",
    );
  return data.results as Record<string, unknown>[];
}

export async function searchPodcasts(
  query: string,
  country: string,
  request = publicFetch,
): Promise<PodcastShow[]> {
  const url = new URL("https://itunes.apple.com/search");
  url.search = new URLSearchParams({
    term: query,
    country,
    media: "podcast",
    entity: "podcast",
    limit: "20",
  }).toString();
  const records = await appleRecords(url.href, request);
  const shows = records.flatMap((record) => {
    const show = showFromRecord(record, country);
    return show ? [show] : [];
  });
  return shows.filter(
    (show, index) => shows.findIndex((item) => item.id === show.id) === index,
  );
}

export async function lookupPodcast(
  id: string,
  country: string,
  request = publicFetch,
): Promise<PodcastShow> {
  const records = await appleRecords(
    `https://itunes.apple.com/lookup?id=${id}&country=${country}&entity=podcast`,
    request,
  );
  const show = records
    .map((record) => showFromRecord(record, country))
    .find((show) => show?.id === id);
  if (!show)
    throw new PodcastImportError("找不到公开播客 / Public podcast not found");
  return show;
}

export async function readPodcastFeed(
  show: PodcastShow,
  request = publicFetch,
): Promise<PodcastEpisode[]> {
  const response = await request(show.feedUrl);
  const items = parseFeed(
    new TextDecoder().decode(await boundedBody(response, 8 * 1024 * 1024)),
  );
  const episodes = items.flatMap((item) => {
    const audioUrl = optionalUrl(item.url);
    if (!audioUrl || item.guid.length > 4096) return [];
    const date = Date.parse(item.publishedAt);
    const transcript = item.transcripts.find((t) =>
      ["text/vtt", "application/x-subrip", "application/srt"].includes(t.type),
    );
    return [
      {
        guid: item.guid || audioUrl,
        title: item.title.slice(0, 300),
        description: item.description
          .replace(/<[^>]*>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 1200),
        publishedAt: Number.isFinite(date)
          ? new Date(date).toISOString()
          : null,
        durationMs: Number.isFinite(item.durationMs)
          ? Math.round(item.durationMs)
          : 0,
        audioUrl,
        mimeType: item.mimeType.startsWith("audio/")
          ? item.mimeType
          : "audio/mpeg",
        transcriptUrl: optionalUrl(transcript?.url),
      },
    ];
  });
  return [...new Map(episodes.map((item) => [item.guid, item])).values()]
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
    .slice(0, 100);
}

export function catalogEpisode(
  show: PodcastShow,
  item: PodcastEpisode,
): Episode {
  if (item.durationMs <= 0 || item.durationMs > MAX_AUDIO_DURATION_MS)
    throw new PodcastImportError(
      "此单集暂无可用时长，请使用 Apple Podcasts 单集分享链接打开 / Use this episode's Apple Podcasts share link; its feed duration is unavailable",
    );
  return {
    id: crypto.randomUUID(),
    title: item.title,
    durationMs: item.durationMs,
    createdAt: new Date().toISOString(),
    status: "queued",
    stage: "可开始收听，正在准备文字稿",
    progress: 0,
    mimeType: item.mimeType,
    podcast: {
      sourceUrl: show.sourceUrl,
      feedUrl: show.feedUrl,
      guid: item.guid,
      audioUrl: item.audioUrl,
      ...(item.transcriptUrl ? { transcriptUrl: item.transcriptUrl } : {}),
    },
  };
}
