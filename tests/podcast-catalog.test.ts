import { test } from "node:test";
import assert from "node:assert/strict";
import {
  searchPodcasts,
  lookupPodcast,
  readPodcastFeed,
  catalogEpisode,
  podcastSelectionSchema,
} from "../backend/src/podcast-catalog.js";
import {
  PodcastDiscovery,
  type PodcastDirectory,
} from "@aside/player-runtime/podcast-discovery";
const show = {
  id: "123",
  title: "A show",
  author: "Host",
  country: "US",
  sourceUrl: "https://podcasts.apple.com/us/podcast/id123",
  feedUrl: "https://feeds.example.com/show",
};
test("directory search encodes keywords and rejects unsafe and duplicate feeds", async () => {
  const results = await searchPodcasts("AI & art", "US", async (url) => {
    assert.equal(new URL(url).searchParams.get("term"), "AI & art");
    return Response.json({
      results: [
        {
          collectionId: 123,
          collectionName: "A show",
          artistName: "Host",
          feedUrl: show.feedUrl,
        },
        {
          collectionId: 123,
          collectionName: "duplicate",
          feedUrl: show.feedUrl,
        },
        {
          collectionId: 456,
          collectionName: "unsafe",
          feedUrl: "http://127.0.0.1/private",
        },
      ],
    });
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].title, show.title);
  await assert.rejects(
    lookupPodcast("99", "US", async () => Response.json({ results: [] })),
    /not found/,
  );
});
test("feed catalog sanitizes descriptions, sorts episodes, and preserves exact identities", async () => {
  const items = await readPodcastFeed(
    show,
    async () =>
      new Response(`<rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
  <item><guid>older</guid><title>Old</title><description><![CDATA[<p>Hello <b>there</b></p>]]></description><pubDate>2026-01-01</pubDate><itunes:duration>1:30</itunes:duration><enclosure url="https://media.example.com/old.mp3" type="audio/mpeg"/></item>
  <item><guid>new</guid><title>New</title><pubDate>2026-09-30</pubDate><enclosure url="https://media.example.com/new.mp3"/></item>
  <item><guid>private</guid><enclosure url="http://localhost/audio"/></item>
  </channel></rss>`),
  );
  assert.deepEqual(
    items.map((item) => item.guid),
    ["new", "older"],
  );
  assert.equal(items[1].description, "Hello there");
  assert.equal(catalogEpisode(show, items[1]).durationMs, 90000);
  assert.throws(() => catalogEpisode(show, items[0]), /duration/);
  assert.throws(() =>
    podcastSelectionSchema.parse({ showId: "../secret", guid: "x" }),
  );
});
test("discovery ignores older searches and requests abandoned by disposal", async () => {
  const pending: ((value: { shows: (typeof show)[] }) => void)[] = [];
  const api: PodcastDirectory = {
    searchPodcasts: () => new Promise((resolve) => pending.push(resolve)),
    podcastShow: async () => ({
      show,
      episodes: [],
      checkedAt: 1,
      stale: false,
    }),
    podcastSubscriptions: async () => ({ subscriptions: [], episodes: [] }),
    subscribePodcast: async () => {},
  };
  const controller = new PodcastDiscovery(api);
  const first = controller.search("first", "US"),
    second = controller.search("second", "US");
  pending[1]({ shows: [show] });
  await second;
  pending[0]({ shows: [] });
  await first;
  assert.equal(controller.state.results.length, 1);
  const third = controller.search("third", "US");
  controller.dispose();
  pending[2]({ shows: [] });
  await third;
  assert.equal(controller.state.results.length, 1);
});

test("subscription loading does not get discarded when a listener starts searching", async () => {
  let resolveSubscriptions!: (value: any) => void;
  const api: PodcastDirectory = {
    searchPodcasts: async () => ({ shows: [show] }),
    podcastShow: async () => ({
      show,
      episodes: [],
      checkedAt: 1,
      stale: false,
    }),
    podcastSubscriptions: () =>
      new Promise((resolve) => {
        resolveSubscriptions = resolve;
      }),
    subscribePodcast: async () => {},
  };
  const controller = new PodcastDiscovery(api);
  const loading = controller.refresh();
  await controller.search("new", "US");
  resolveSubscriptions({
    subscriptions: [{ show, subscribedAt: 1, checkedAt: 1, stale: false }],
    episodes: [],
  });
  await loading;
  assert.equal(controller.state.subscriptions.subscriptions.length, 1);
  assert.equal(controller.state.results.length, 1);
  assert.equal(controller.state.busy, false);
});

test("large RSS archives stop after 100 complete items without reading the tail", async () => {
  let canceled = false;
  const head =
    "<rss><channel>" +
    Array.from(
      { length: 100 },
      (_, i) =>
        `<item><guid>${i}</guid><title>Episode ${i}</title><description><![CDATA[Quoted </item> marker]]></description><!-- </item> --><enclosure url="https://media.example.com/${i}.mp3"/></item>`,
    ).join("");
  const bytes = new TextEncoder().encode(head);
  let offset = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset < bytes.length) {
          const next = Math.min(offset + 37, bytes.length);
          controller.enqueue(bytes.slice(offset, next));
          offset = next;
        } else
          controller.enqueue(
            new TextEncoder().encode("tail that must never be parsed"),
          );
      },
      cancel() {
        canceled = true;
      },
    }),
    { headers: { "Content-Length": String(32 * 1024 * 1024) } },
  );
  const episodes = await readPodcastFeed(show, async () => response);
  assert.equal(episodes.length, 100);
  assert.equal(episodes[99].guid, "99");
  assert.equal(canceled, true);
});
