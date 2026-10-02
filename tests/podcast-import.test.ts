import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appleEpisodeLink,
  parseFeed,
  parseTimedTranscript,
  resolveAppleEpisode,
} from "../backend/src/podcast-import.js";
import {
  publicUrl,
  publicFetch,
  boundedBody,
} from "../backend/src/public-fetch.js";
const link = "https://podcasts.apple.com/us/podcast/example/id123?i=456&t=90";
const rss = `<?xml version="1.0"?><rss xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><item><guid>one</guid><title><![CDATA[A & B]]></title><enclosure url="https://media.example.com/one.mp3" type="audio/mpeg"/><itunes:duration>1:30</itunes:duration><podcast:transcript url="https://media.example.com/one.vtt" type="text/vtt"/></item></channel></rss>`;
test("only Apple single-episode links are accepted and explicit timestamps survive", () => {
  assert.equal(appleEpisodeLink(link).positionMs, 90000);
  for (const bad of [
    "https://podcasts.apple.com/us/podcast/example/id123",
    "https://podcasts.apple.com.evil.com/id123?i=456",
    "file:///id123?i=456",
  ])
    assert.throws(() => appleEpisodeLink(bad));
});
test("RSS parser preserves GUIDs, enclosure and timed transcript links", () => {
  assert.equal(parseFeed(rss)[0].title, "A & B");
  assert.equal(parseFeed(rss)[0].durationMs, 90000);
  assert.equal(parseFeed(rss)[0].transcripts[0].type, "text/vtt");
  assert.throws(() => parseFeed("<!DOCTYPE rss><rss/>"));
});
test("Apple mapping requires an exact public RSS episode rather than guessing by title", async () => {
  const request = async (url: string) =>
    url.includes("/lookup")
      ? Response.json({
          results: [
            { collectionId: 123, feedUrl: "https://feeds.example.com/show" },
            { trackId: 456, episodeGuid: "one", trackTimeMillis: 120000 },
          ],
        })
      : new Response(rss);
  const result = await resolveAppleEpisode(link, request);
  assert.equal(
    result.episode.podcast?.audioUrl,
    "https://media.example.com/one.mp3",
  );
  assert.equal(result.positionMs, 90000);
  assert.equal(result.episode.status, "queued");
  await assert.rejects(
    resolveAppleEpisode(link, async (url) =>
      url.includes("/lookup")
        ? Response.json({
            results: [
              { collectionId: 123, feedUrl: "https://feeds.example.com/show" },
              { trackId: 456, episodeGuid: "absent" },
            ],
          })
        : new Response(rss),
    ),
    /not in the public RSS/,
  );
});
test("VTT and SRT produce timestamped passages without sending audio to transcription", () => {
  const vtt =
    "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Host>Hello there</v>\n\n";
  const srt = "1\n00:00:01,000 --> 00:00:03,000\nHello there\n\n";
  assert.deepEqual(
    parseTimedTranscript(vtt, 10000),
    parseTimedTranscript(srt, 10000),
  );
  assert.equal(parseTimedTranscript(vtt, 10000)[0].startMs, 1000);
  assert.throws(
    () =>
      parseTimedTranscript(
        vtt + "00:01:00.000 --> 00:01:02.000\nWrong audio version",
        10000,
      ),
    /timing/,
  );
});
test("public fetch rejects private hosts and private redirect destinations before requesting them", async () => {
  for (const url of [
    "http://127.0.0.1/x",
    "http://10.0.0.1/x",
    "http://localhost/x",
    "http://user:pass@example.com/x",
    "http://[::1]/x",
  ])
    assert.throws(() => publicUrl(url));
  const seen: string[] = [];
  const request: typeof fetch = async (input) => {
    const url = String(input);
    seen.push(url);
    if (url.includes("dns-query"))
      return Response.json({ Answer: [{ type: 1, data: "93.184.216.34" }] });
    return new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/secret" },
    });
  };
  await assert.rejects(
    publicFetch("https://feeds.example.com/feed", {}, request),
  );
  assert.equal(
    seen.some((url) => url.includes("/secret")),
    false,
  );
  await assert.rejects(
    publicFetch("https://feeds.example.com/feed", {}, async () =>
      Response.json({ Answer: [{ type: 1, data: "10.0.0.5" }] }),
    ),
    /not public/,
  );
});
test("chunked RSS responses are bounded even without a content length", async () => {
  await assert.rejects(
    boundedBody(new Response("x".repeat(100)), 10),
    /too large/,
  );
});

test("local podcast connections reject private addresses at socket resolution", async () => {
  const { publicLookup } = await import("../backend/src/public-fetch-node.js");
  for (const hostname of ["127.0.0.1", "::1", "10.0.0.1"]) {
    await assert.rejects(
      new Promise((resolve, reject) => {
        publicLookup(hostname, { all: true }, (error, address) =>
          error ? reject(error) : resolve(address),
        );
      }),
      /not public/,
    );
  }
  const resolved = await new Promise((resolve, reject) => {
    publicLookup("93.184.216.34", { all: true }, (error, address) =>
      error ? reject(error) : resolve(address),
    );
  });
  assert.deepEqual(resolved, [{ address: "93.184.216.34", family: 4 }]);
});
