import { groupByCollection, type Episode } from "@aside/engine/core";

/**
 * Builders for the search-engine surface: head blocks, JSON-LD, crawler-visible
 * bodies and the sitemap. Pure string work with no database or `Env` access, so
 * the root TypeScript program can type-check it without Workers types.
 *
 * The copy here mirrors `frontend/src/i18n.ts`; `tests/seo.test.ts` fails if the
 * two drift apart.
 */
export const SITE = "https://asidefm.com";
export type SeoLocale = "en" | "zh";

/** `/` is the English page; Chinese lives under its own path so hreflang works. */
export const homePath: Record<SeoLocale, string> = { en: "/", zh: "/zh" };

export const titles: Record<SeoLocale, string> = {
  en: "Aside · Interrupt a podcast, ask out loud, keep listening",
  zh: "Aside · 用语音打断播客，随口提问接着听",
};
export const descriptions: Record<SeoLocale, string> = {
  en: "Aside is a podcast player you can talk back to: interrupt an episode to ask by voice, keep the conversation going, and resume from a complete sentence.",
  zh: "Aside 是一个可以插话的播客播放器：听到好奇的地方开口提问，AI 结合前文回答，聊完从完整的一句话接着听。",
};
export const heroHeadings: Record<SeoLocale, readonly [string, string]> = {
  en: ["Recorded then.", "Your turn now."],
  zh: ["对话发生过，", "你依然可以加入。"],
};
const eyebrows: Record<SeoLocale, string> = {
  en: "Past voices. Present conversations.",
  zh: "让过去的声音，成为此刻的对话",
};
const taglines: Record<SeoLocale, string> = {
  en: "A new possibility for listening.",
  zh: "让聆听，多一种可能。",
};
const libraryEyebrows: Record<SeoLocale, string> = {
  en: "START HERE",
  zh: "从这里开始",
};
const libraryHeadings: Record<SeoLocale, string> = {
  en: "A few minutes. A new way to listen.",
  zh: "留几分钟，试着聊两句。",
};
const libraryIntros: Record<SeoLocale, string> = {
  en: "Pick something that interests you. When a thought comes to mind, jump into the conversation.",
  zh: "挑一段感兴趣的，听到有想法时，就开口聊聊。",
};

export const indexRobots =
  "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1";
export const spaceTitles: Record<SeoLocale, string> = {
  en: "Your space · Aside",
  zh: "我的空间 · Aside",
};

const headStart = "<!--aside:seo:head:start-->";
const headEnd = "<!--aside:seo:head:end-->";
const bodyStart = "<!--aside:seo:body:start-->";
const bodyEnd = "<!--aside:seo:body:end-->";

/** How many transcript passages an episode page exposes as indexable text. */
const passageLimit = 6;

/**
 * Routes whose page is the client-rendered shell. When the search-engine work
 * fails, only these may fall back to the app; a broken sitemap must not answer
 * with a 200 HTML page.
 */
export function isShellRoute(path: string) {
  return (
    path === "/" ||
    path === "/index.html" ||
    path === "/zh" ||
    path === "/zh/" ||
    path === "/space" ||
    path.startsWith("/space/") ||
    path.startsWith("/episodes/")
  );
}

export function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

/** JSON inside a `<script>` element must not be able to close it early. */
function jsonScript(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function episodePath(id: string) {
  return `/episodes/${encodeURIComponent(id)}`;
}

export function episodeUrl(id: string) {
  return SITE + episodePath(id);
}

export interface SeoHead {
  title: string;
  description: string;
  canonical?: string;
  robots: string;
  locale: SeoLocale;
  alternates?: readonly { hreflang: string; href: string }[];
  jsonLd: unknown;
}

/** The card image carries a headline, so it follows the page language too. */
const cardImages: Record<SeoLocale, { url: string; alt: string }> = {
  en: {
    url: `${SITE}/og-image.png`,
    alt: "Aside — a podcast player you can talk back to",
  },
  zh: {
    url: `${SITE}/og-image-zh.png`,
    alt: "Aside — 可以插话的播客播放器",
  },
};

export function seoHead(head: SeoHead): string {
  const lines = [
    `<title>${escapeHtml(head.title)}</title>`,
    `<meta name="description" content="${escapeHtml(head.description)}" />`,
    `<meta name="robots" content="${escapeHtml(head.robots)}" />`,
  ];
  if (head.canonical)
    lines.push(`<link rel="canonical" href="${escapeHtml(head.canonical)}" />`);
  for (const alternate of head.alternates ?? [])
    lines.push(
      `<link rel="alternate" hreflang="${escapeHtml(alternate.hreflang)}" href="${escapeHtml(alternate.href)}" />`,
    );
  const zh = head.locale === "zh";
  const card = cardImages[head.locale];
  lines.push(
    `<meta property="og:title" content="${escapeHtml(head.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(head.description)}" />`,
    `<meta property="og:url" content="${escapeHtml(head.canonical ?? SITE + "/")}" />`,
    `<meta property="og:locale" content="${zh ? "zh_CN" : "en_US"}" />`,
    `<meta property="og:locale:alternate" content="${zh ? "en_US" : "zh_CN"}" />`,
    `<meta property="og:image" content="${card.url}" />`,
    `<meta property="og:image:alt" content="${escapeHtml(card.alt)}" />`,
    `<meta name="twitter:title" content="${escapeHtml(head.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(head.description)}" />`,
    `<meta name="twitter:image" content="${card.url}" />`,
    `<meta name="twitter:image:alt" content="${escapeHtml(card.alt)}" />`,
    `<script type="application/ld+json">${jsonScript(head.jsonLd)}</script>`,
  );
  return lines.join("\n    ");
}

export function languageAlternates() {
  return [
    { hreflang: "en", href: `${SITE}/` },
    { hreflang: "zh", href: `${SITE}/zh` },
    { hreflang: "x-default", href: `${SITE}/` },
  ];
}

/**
 * Mirror of `libraryFor`'s visibility rule. The Worker cannot import the
 * frontend (React), so the comparison is restated here on the primary subtag.
 */
export function episodesFor(episodes: Episode[], locale: SeoLocale) {
  const code = (value: string | undefined) =>
    value?.toLowerCase().split(/[-_]/)[0];
  const visible = episodes.filter((episode) => {
    const visibility: unknown = episode.attribution?.languageVisibility;
    if (!Array.isArray(visibility) || !visibility.length) return true;
    return visibility.some((entry) => code(String(entry)) === locale);
  });
  const ordered = visible
    .map((episode, index) => ({ episode, index }))
    .sort(
      (a, b) =>
        Number(code(a.episode.attribution?.language) !== locale) -
          Number(code(b.episode.attribution?.language) !== locale) ||
        a.index - b.index,
    )
    .map((entry) => entry.episode);
  // Collection by collection, as the page lists them, so the JSON-LD item
  // positions match what a reader sees.
  return groupByCollection(ordered, locale).flatMap((group) => group.episodes);
}

function duration(episode: Episode) {
  const seconds = Math.floor(episode.durationMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** ISO 8601 duration, as schema.org expects. */
function isoTimestamp(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `PT${hours ? `${hours}H` : ""}${minutes ? `${minutes}M` : ""}${seconds}S`;
}

function inLanguage(episode: Episode) {
  const language = episode.attribution?.language?.toLowerCase() ?? "";
  if (language.startsWith("zh")) return "zh-CN";
  if (language.startsWith("en")) return "en";
  return language || "en";
}

export function webSiteNode(locale: SeoLocale) {
  return {
    "@type": "WebSite",
    "@id": `${SITE}/#website`,
    url: `${SITE}${homePath[locale]}`,
    name: "Aside",
    description: descriptions[locale],
    inLanguage: ["en", "zh-CN"],
  };
}

function webAppNode(locale: SeoLocale) {
  return {
    "@type": "WebApplication",
    "@id": `${SITE}/#webapp`,
    name: "Aside",
    url: `${SITE}${homePath[locale]}`,
    applicationCategory: "MultimediaApplication",
    operatingSystem: "Web",
    browserRequirements:
      "Requires a browser with Web Audio, MediaRecorder and WebRTC support.",
    description: descriptions[locale],
    inLanguage: ["en", "zh-CN"],
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  };
}

export function homeJsonLd(locale: SeoLocale, episodes: Episode[]) {
  const graph: unknown[] = [webSiteNode(locale), webAppNode(locale)];
  if (episodes.length)
    graph.push({
      "@type": "ItemList",
      "@id": `${SITE}${homePath[locale]}#library`,
      name: libraryHeadings[locale],
      numberOfItems: episodes.length,
      itemListElement: episodes.map((episode, index) => ({
        "@type": "ListItem",
        position: index + 1,
        url: episodeUrl(episode.id),
        name: episode.title,
      })),
    });
  return { "@context": "https://schema.org", "@graph": graph };
}

export function episodeJsonLd(episode: Episode, summary: string) {
  const attribution = episode.attribution;
  const node: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "PodcastEpisode",
    name: episode.title,
    url: episodeUrl(episode.id),
    inLanguage: inLanguage(episode),
    datePublished: episode.createdAt,
    isAccessibleForFree: true,
    associatedMedia: {
      "@type": "AudioObject",
      contentUrl: `${SITE}/api/episodes/${encodeURIComponent(episode.id)}/audio`,
      encodingFormat: episode.mimeType ?? "audio/mpeg",
      duration: isoTimestamp(episode.durationMs),
    },
  };
  if (summary) node.description = summary;
  if (episode.cover)
    node.thumbnailUrl = `${SITE}/api/episodes/${encodeURIComponent(episode.id)}/cover`;
  if (attribution) {
    if (attribution.author)
      node.author = { "@type": "Person", name: attribution.author };
    if (attribution.publisher)
      node.publisher = { "@type": "Organization", name: attribution.publisher };
    if (attribution.licenseUrl) node.license = attribution.licenseUrl;
    if (attribution.sourceUrl) node.isBasedOn = attribution.sourceUrl;
  }
  return node;
}

export function homeBody(locale: SeoLocale, episodes: Episode[]): string {
  const [first, second] = heroHeadings[locale];
  const library = groupByCollection(episodes, locale)
    .map((group) => {
      const items = group.episodes
        .map((episode) => {
          const meta = [
            episode.attribution?.publisher,
            episode.attribution?.author,
            duration(episode),
          ]
            .filter(Boolean)
            .join(" · ");
          return `<li><a href="${episodePath(episode.id)}"><span class="sample-icon" aria-hidden="true">▶</span><span><strong>${escapeHtml(episode.title)}</strong><small>${escapeHtml(meta)}</small></span></a></li>`;
        })
        .join("\n            ");
      const heading = group.title
        ? `<h3 class="sample-collection-title">${escapeHtml(group.title)}</h3>
          `
        : "";
      return `${heading}<ul class="sample-list">
            ${items}
          </ul>`;
    })
    .join("\n          ");
  return `<div class="landing"><main class="landing-main">
        <section class="hero" aria-labelledby="hero-title">
          <div class="hero-copy">
            <p class="hero-eyebrow"><span></span>${escapeHtml(eyebrows[locale])}</p>
            <h1 id="hero-title">${escapeHtml(first)}<br /><em>${escapeHtml(second)}</em></h1>
            <p class="hero-description">${escapeHtml(taglines[locale])}</p>
          </div>
        </section>
        <section class="landing-library" aria-labelledby="sample-title">
          <div class="library-intro">
            <span class="hero-eyebrow">${escapeHtml(libraryEyebrows[locale])}</span>
            <h2 id="sample-title">${escapeHtml(libraryHeadings[locale])}</h2>
            <p>${escapeHtml(libraryIntros[locale])}</p>
          </div>
          ${library}
        </section>
      </main></div>`;
}

export function episodeBody(
  locale: SeoLocale,
  episode: Episode,
  summary: string,
  passages: readonly string[],
): string {
  const attribution = episode.attribution;
  const meta = [
    attribution?.author,
    attribution?.publisher,
    duration(episode),
    attribution?.language,
  ]
    .filter(Boolean)
    .join(" · ");
  const source = attribution?.sourceUrl
    ? `<p><a href="${escapeHtml(attribution.sourceUrl)}" rel="external nofollow">${escapeHtml(attribution.publisher || attribution.sourceUrl)}</a> — ${escapeHtml(attribution.license)}</p>`
    : "";
  const transcript = passages.length
    ? `<h2>${locale === "zh" ? "逐字稿" : "Transcript"}</h2><ol>${passages.map((text) => `<li>${escapeHtml(text)}</li>`).join("")}</ol>`
    : "";
  return `<main>
        <h1>${escapeHtml(episode.title)}</h1>
        <p>${escapeHtml(meta)}</p>
        <p>${escapeHtml(summary)}</p>
        ${source}
        ${transcript}
      </main>`;
}

export function sitemap(episodes: Episode[], lastModified: string): string {
  const url = (loc: string, lastmod?: string) =>
    `  <url>\n    <loc>${escapeHtml(loc)}</loc>${
      lastmod ? `\n    <lastmod>${escapeHtml(lastmod)}</lastmod>` : ""
    }\n  </url>`;
  const entries = [
    url(`${SITE}/`, lastModified),
    url(`${SITE}/zh`, lastModified),
  ];
  for (const episode of episodes)
    entries.push(url(episodeUrl(episode.id), episode.createdAt));
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join("\n")}
</urlset>
`;
}

/** Replaces the region between two marker comments, or leaves the shell alone. */
function replaceRegion(
  html: string,
  start: string,
  end: string,
  content: string,
) {
  const from = html.indexOf(start);
  const to = html.indexOf(end);
  if (from === -1 || to === -1 || to < from) return html;
  return `${html.slice(0, from + start.length)}\n    ${content}\n    ${html.slice(to)}`;
}

export function inject(
  html: string,
  head: string,
  body: string,
  lang?: string,
) {
  const localized =
    lang && lang !== "en"
      ? html.replace('<html lang="en">', `<html lang="${lang}">`)
      : html;
  const withHead = replaceRegion(localized, headStart, headEnd, head);
  return replaceRegion(withHead, bodyStart, bodyEnd, body);
}

/** The page for a recording is written in the recording's own language. */
export function localeOf(episode: Episode): SeoLocale {
  return episode.attribution?.language?.toLowerCase().startsWith("zh")
    ? "zh"
    : "en";
}

/** Passages an episode page exposes; kept here so the route layer stays thin. */
export function indexablePassages(episode: Episode) {
  return (episode.analysis?.passages ?? [])
    .slice(0, passageLimit)
    .map((passage) => passage.text.trim())
    .filter(Boolean);
}
