import { XMLParser } from "fast-xml-parser";
import {
  MAX_AUDIO_DURATION_MS,
  type Episode,
  type Passage,
} from "@aside/engine/core";
import { publicFetch, publicUrl, boundedBody } from "./public-fetch.js";
const list = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
const text = (value: unknown): string =>
  typeof value === "object" && value !== null
    ? text((value as Record<string, unknown>)["#text"])
    : String(value ?? "");
export class PodcastImportError extends Error {}
export function appleEpisodeLink(value: string) {
  const url = URL.parse(value.trim());
  if (!url)
    throw new PodcastImportError(
      "请分享 Apple Podcasts 的单集链接 / Share an Apple Podcasts episode link",
    );
  const showId = /\/id(\d+)/.exec(url.pathname)?.[1];
  const episodeId = url.searchParams.get("i");
  if (
    url.protocol !== "https:" ||
    url.hostname !== "podcasts.apple.com" ||
    !showId ||
    !episodeId ||
    !/^\d+$/.test(episodeId)
  )
    throw new PodcastImportError(
      "请分享 Apple Podcasts 的单集链接 / Share an Apple Podcasts episode link",
    );
  const country = /^\/([a-z]{2})\//i.exec(url.pathname)?.[1] ?? "us";
  const seconds = Number(url.searchParams.get("t") ?? 0);
  return {
    showId,
    episodeId,
    country,
    positionMs: Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 0,
    url: url.href,
  };
}
export function parseFeed(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw Error("Unsupported RSS document");
  const feed = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: true,
  }).parse(xml);
  const channel = feed.rss?.channel;
  if (!channel) throw Error("Public RSS feed unavailable");
  return list<Record<string, any>>(channel.item).map((item) => ({
    guid: text(item.guid),
    title: text(item.title),
    description: text(item.description || item["itunes:summary"]),
    publishedAt: text(item.pubDate),
    url: text(item.enclosure?.["@_url"]),
    mimeType: text(item.enclosure?.["@_type"]),
    durationMs:
      text(item["itunes:duration"])
        .split(":")
        .reduce((a, n) => a * 60 + Number(n), 0) * 1000,
    transcripts: list<Record<string, string>>(item["podcast:transcript"]).map(
      (t) => ({ url: t["@_url"], type: t["@_type"] }),
    ),
  }));
}
export async function resolveAppleEpisode(
  value: string,
  request: typeof publicFetch = publicFetch,
) {
  const link = appleEpisodeLink(value);
  const results = await Promise.all(
    [link.showId, link.episodeId].map(async (id) => {
      const r = await request(
        `https://itunes.apple.com/lookup?id=${id}&entity=podcastEpisode&country=${link.country}&limit=200`,
      );
      return JSON.parse(
        new TextDecoder().decode(await boundedBody(r, 4 * 1024 * 1024)),
      ).results as Record<string, any>[];
    }),
  );
  const records = results.flat();
  const show = records.find(
    (r) => String(r.collectionId) === link.showId && r.feedUrl,
  );
  const selected = records.find((r) => String(r.trackId) === link.episodeId);
  if (!show?.feedUrl || !selected)
    throw new PodcastImportError(
      "找不到公开的单集 RSS，订阅专享内容暂不支持 / Public episode feed unavailable",
    );
  const feedUrl = publicUrl(show.feedUrl).href;
  const feed = parseFeed(
    new TextDecoder().decode(
      await boundedBody(await request(feedUrl), 8 * 1024 * 1024),
    ),
  );
  const item =
    feed.find((i) => selected.episodeGuid && i.guid === selected.episodeGuid) ??
    feed.find((i) => selected.episodeUrl && i.url === selected.episodeUrl);
  if (!item?.url)
    throw new PodcastImportError(
      "这集不在公开 RSS 中 / Episode is not in the public RSS feed",
    );
  const durationMs = Number(selected.trackTimeMillis) || item.durationMs;
  if (
    !Number.isFinite(durationMs) ||
    durationMs <= 0 ||
    durationMs > MAX_AUDIO_DURATION_MS
  )
    throw new PodcastImportError(
      "不支持该集时长 / Unsupported episode duration",
    );
  const transcript = item.transcripts.find((t) =>
    ["text/vtt", "application/x-subrip", "application/srt"].includes(t.type),
  );
  const episode: Episode = {
    id: crypto.randomUUID(),
    title: item.title.slice(0, 200),
    durationMs,
    createdAt: new Date().toISOString(),
    status: "queued",
    stage: "可开始收听，正在准备文字稿",
    progress: 0,
    mimeType: item.mimeType.startsWith("audio/") ? item.mimeType : "audio/mpeg",
    podcast: {
      sourceUrl: link.url,
      feedUrl,
      guid: item.guid || item.url,
      audioUrl: publicUrl(item.url).href,
      ...(transcript ? { transcriptUrl: publicUrl(transcript.url).href } : {}),
    },
  };
  return { episode, positionMs: Math.min(link.positionMs, durationMs) };
}
function timestamp(s: string) {
  return (
    s
      .replace(",", ".")
      .split(":")
      .reduce((n, part) => n * 60 + Number(part), 0) * 1000
  );
}
export function parseTimedTranscript(
  value: string,
  durationMs: number,
): Passage[] {
  const passages: Passage[] = [];
  for (const block of value.replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const index = lines.findIndex((l) => l.includes("-->"));
    if (index < 0) continue;
    const match = /([\d:.,]+)\s+-->\s+([\d:.,]+)/.exec(lines[index]);
    if (!match) throw Error("Invalid transcript cue");
    const startMs = timestamp(match[1]),
      endMs = timestamp(match[2]);
    const content = lines
      .slice(index + 1)
      .join(" ")
      .replace(/<[^>]*>/g, "")
      .trim();
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      startMs < 0 ||
      endMs <= startMs ||
      endMs > durationMs + 2000
    )
      throw Error("Transcript timing does not match this episode");
    if (!content) continue;
    passages.push({
      id: `rss-${passages.length}`,
      startMs,
      endMs,
      text: content,
      speaker: "unknown",
    });
  }
  if (!passages.length) throw Error("No timed transcript found");
  return passages.sort((a, b) => a.startMs - b.startMs);
}
export async function publisherTranscript(
  episode: Episode,
  request = publicFetch,
) {
  if (!episode.podcast?.transcriptUrl) return;
  try {
    const r = await request(episode.podcast.transcriptUrl);
    return parseTimedTranscript(
      new TextDecoder().decode(await boundedBody(r, 8 * 1024 * 1024)),
      episode.durationMs,
    );
  } catch {
    return undefined;
  }
}

/** Web audio stays same-origin so its analyser can read samples from podcast hosts without CORS. */
export async function streamPodcastAudio(
  url: string,
  method: string,
  range?: string | null,
  signal?: AbortSignal,
  request = publicFetch,
) {
  if (range && !/^bytes=\d*-\d*$/.test(range))
    return new Response(null, { status: 416 });
  const upstream = await request(
    url,
    {
      method,
      signal,
      headers: range ? { Range: range } : {},
    },
    fetch,
    6 * 60 * 60 * 1000,
  );
  const headers = new Headers({ "Cache-Control": "private, no-store" });
  for (const name of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers,
  });
}
