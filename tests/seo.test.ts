import { test } from "node:test";
import assert from "node:assert/strict";
import type { Episode } from "../engine/src/core";
import {
  descriptions,
  episodeBody,
  episodeJsonLd,
  episodeUrl,
  episodesFor,
  heroHeadings,
  homeBody,
  homeJsonLd,
  inject,
  isShellRoute,
  localeOf,
  seoHead,
  sitemap,
  titles,
} from "../cloudflare/src/seo-html";
import {
  descriptions as uiDescriptions,
  english,
  ownsDocumentHead,
  titles as uiTitles,
} from "../frontend/src/i18n";

function episode(overrides: Partial<Episode> & { id: string }): Episode {
  return {
    title: "Episode",
    createdAt: "2026-09-14T07:43:00.000Z",
    durationMs: 250220,
    status: "ready",
    stage: "分析完成",
    progress: 1,
    ...overrides,
  };
}

test("worker SEO copy stays in step with the interface copy", () => {
  // The Worker cannot import the React i18n module at runtime, so the two
  // copies are duplicated on purpose; this keeps the duplication honest.
  assert.equal(titles.en, uiTitles.en);
  assert.equal(titles.zh, uiTitles.zh);
  assert.equal(descriptions.en, uiDescriptions.en);
  assert.equal(descriptions.zh, uiDescriptions.zh);
  assert.deepEqual([...heroHeadings.en], [english["对话发生过，"], english["你依然可以加入。"]]);
});

test("the client leaves an episode page's server-rendered head alone", () => {
  // Rewriting it with the landing title made Google fold episodes into "/".
  assert.equal(ownsDocumentHead("/episodes/luxun-ah-q"), true);
  assert.equal(ownsDocumentHead("/episodes/luxun-ah-q/"), true);
  assert.equal(ownsDocumentHead("/"), false);
  assert.equal(ownsDocumentHead("/zh"), false);
  assert.equal(ownsDocumentHead("/space"), false);
});

test("seoHead emits one canonical, language alternates and escaped text", () => {
  const head = seoHead({
    title: 'Aside <script>alert("x")</script>',
    description: "d",
    canonical: "https://asidefm.com/zh",
    robots: "index, follow",
    locale: "zh",
    alternates: [{ hreflang: "en", href: "https://asidefm.com/" }],
    jsonLd: { "@type": "WebSite" },
  });
  assert.match(head, /<link rel="canonical" href="https:\/\/asidefm\.com\/zh" \/>/);
  assert.match(head, /hreflang="en"/);
  assert.ok(!head.includes("<script>alert"), "title must be escaped");
  assert.match(head, /og:locale" content="zh_CN"/);
  assert.match(head, /og:image" content="https:\/\/asidefm\.com\/og-image-zh\.png"/);
  assert.match(head, /twitter:image" content="https:\/\/asidefm\.com\/og-image-zh\.png"/);
});

test("seoHead pairs the English page with the English card image", () => {
  const head = seoHead({
    title: "Aside",
    description: "d",
    robots: "index, follow",
    locale: "en",
    jsonLd: {},
  });
  assert.match(head, /og:image" content="https:\/\/asidefm\.com\/og-image\.png"/);
  assert.match(head, /twitter:image" content="https:\/\/asidefm\.com\/og-image\.png"/);
});

test("inject swaps both shell regions and survives a shell without markers", () => {
  const shell = `<!doctype html><html lang="en"><head><!--aside:seo:head:start-->old head<!--aside:seo:head:end--></head><body><div id="root"><!--aside:seo:body:start-->old body<!--aside:seo:body:end--></div></body></html>`;
  const injected = inject(shell, "NEW HEAD", "NEW BODY", "zh-CN");
  assert.ok(injected.includes("NEW HEAD") && injected.includes("NEW BODY"));
  assert.ok(!injected.includes("old head") && !injected.includes("old body"));
  assert.ok(injected.includes('<html lang="zh-CN">'));
  assert.equal(inject("<html></html>", "a", "b"), "<html></html>");
});

test("home body links each public recording at its own URL", () => {
  const body = homeBody("zh", [
    episode({ id: "luxun-ah-q", title: "阿Q正传" }),
  ]);
  assert.match(body, /<a href="\/episodes\/luxun-ah-q">/);
  assert.ok(body.includes("阿Q正传"));
  assert.match(body, /<h1 id="hero-title">/);
});

test("home body lists recordings under their collection heading", () => {
  const shelf = (id: string, zh: string) => ({
    publisher: "p",
    author: "a",
    sourceUrl: "s",
    licenseUrl: "l",
    license: "x",
    language: "zh",
    collection: { id, title: { zh, en: id } },
    excerptStartMs: 0,
    excerptEndMs: 1,
  });
  const body = homeBody("zh", [
    episode({ id: "one", attribution: shelf("nahan", "鲁迅《呐喊》") }),
    episode({ id: "two", attribution: shelf("speeches", "<演讲>") }),
    episode({ id: "three", attribution: shelf("nahan", "鲁迅《呐喊》") }),
  ]);
  assert.equal(body.match(/<h3 class="sample-collection-title">/g)?.length, 2);
  assert.ok(body.includes("&lt;演讲&gt;"), "collection title must be escaped");
  const order = [
    "鲁迅《呐喊》",
    "/episodes/one",
    "/episodes/three",
    "/episodes/two",
  ];
  assert.deepEqual(
    [...order].sort((a, b) => body.indexOf(a) - body.indexOf(b)),
    order,
  );
});

test("recording titles cannot break out of the injected markup", () => {
  const body = homeBody("en", [
    episode({ id: "x", title: '</a><img src=x onerror="alert(1)">' }),
  ]);
  assert.ok(!body.includes("<img src=x"), "title must be escaped");
});

test("the library follows the interface language without hiding anything", () => {
  const zh = episode({
    id: "zh",
    attribution: {
      publisher: "p",
      author: "a",
      sourceUrl: "s",
      licenseUrl: "l",
      license: "lic",
      language: "zh",
      languageVisibility: ["zh-cn"],
      excerptStartMs: 0,
      excerptEndMs: 1,
    },
  });
  const en = episode({
    id: "en",
    attribution: { ...zh.attribution!, language: "en", languageVisibility: ["en"] },
  });
  assert.deepEqual(
    episodesFor([en, zh], "zh").map((item) => item.id),
    ["zh"],
  );
  assert.deepEqual(
    episodesFor([en, zh], "en").map((item) => item.id),
    ["en"],
  );
});

test("sitemap lists both languages and every public recording", () => {
  const xml = sitemap([episode({ id: "luxun-ah-q" })], "2026-09-15");
  assert.match(xml, /<loc>https:\/\/asidefm\.com\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/asidefm\.com\/zh<\/loc>/);
  assert.match(xml, /<loc>https:\/\/asidefm\.com\/episodes\/luxun-ah-q<\/loc>/);
  assert.match(xml, /<lastmod>2026-09-14T07:43:00\.000Z<\/lastmod>/);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
});

test("an episode page carries playable audio and its source", () => {
  const value = episode({
    id: "luxun-ah-q",
    title: "阿Q正传",
    attribution: {
      publisher: "LibriVox",
      author: "鲁迅",
      sourceUrl: "https://archive.org/details/truestoryahq_1612_librivox",
      licenseUrl: "https://librivox.org/pages/public-domain/",
      license: "Public domain",
      language: "zh",
      excerptStartMs: 0,
      excerptEndMs: 1,
    },
  });
  const json = episodeJsonLd(value, "summary") as Record<string, any>;
  assert.equal(json["@type"], "PodcastEpisode");
  assert.equal(json.url, episodeUrl("luxun-ah-q"));
  assert.equal(json.associatedMedia.duration, "PT4M10S");
  assert.equal(json.author.name, "鲁迅");
  assert.equal(json.inLanguage, "zh-CN");
  const body = episodeBody("zh", value, "summary", ["第一句。"]);
  assert.match(body, /<h1>阿Q正传<\/h1>/);
  assert.match(body, /<h2>逐字稿<\/h2>/);
  assert.match(body, /第一句。/);
});

test("home JSON-LD keeps the site nodes and itemises the library", () => {
  const json = homeJsonLd("en", [episode({ id: "jfk-rice-moon" })]) as {
    "@graph": Array<Record<string, any>>;
  };
  const types = json["@graph"].map((node) => node["@type"]);
  assert.deepEqual(types, ["WebSite", "WebApplication", "ItemList"]);
  const list = json["@graph"][2];
  assert.equal(list.itemListElement[0].url, "https://asidefm.com/episodes/jfk-rice-moon");
});

test("an episode page follows the recording's own language", () => {
  assert.equal(localeOf(episode({ id: "zh", title: "阿Q正传" })), "en");
  assert.equal(
    localeOf(
      episode({
        id: "zh",
        title: "阿Q正传",
        attribution: {
          publisher: "LibriVox",
          author: "鲁迅",
          sourceUrl: "s",
          licenseUrl: "l",
          license: "lic",
          language: "zh-CN",
          excerptStartMs: 0,
          excerptEndMs: 1,
        },
      }),
    ),
    "zh",
  );
});

test("only shell routes fall back to the app shell", () => {
  for (const path of ["/", "/zh", "/space", "/space/x", "/episodes/a-b"])
    assert.equal(isShellRoute(path), true, path);
  for (const path of ["/sitemap.xml", "/nope", "/assets/index.js", "/robots.txt"])
    assert.equal(isShellRoute(path), false, path);
});
