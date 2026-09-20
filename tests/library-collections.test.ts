import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { groupByCollection, type Episode } from "@aside/engine/core";
import { libraryCards } from "../frontend/src/library-item";
import {
  collectionFor,
  type CollectionTitles,
  type SampleSpec,
} from "../scripts/sample-spec";

function episode(
  id: string,
  language: string,
  collection?: { id: string; title: Record<string, string> },
): Episode {
  return {
    id,
    title: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    durationMs: 60_000,
    status: "ready",
    stage: "",
    progress: 1,
    attribution: {
      publisher: "publisher",
      author: `author of ${id}`,
      sourceUrl: "https://example.test/source",
      licenseUrl: "https://example.test/license",
      license: "license",
      language,
      ...(collection ? { collection } : {}),
      excerptStartMs: 0,
      excerptEndMs: 60_000,
    },
  };
}

const speeches = { id: "speeches", title: { zh: "演讲", en: "Speeches" } };
const stories = { id: "stories", title: { zh: "小说", en: "Stories" } };

test("collections keep the order their first recording arrived in", () => {
  const groups = groupByCollection(
    [
      episode("a", "en", speeches),
      episode("b", "zh", stories),
      episode("c", "en", speeches),
    ],
    "en",
  );
  assert.deepEqual(
    groups.map((group) => [group.title, group.episodes.map((e) => e.id)]),
    [
      ["Speeches", ["a", "c"]],
      ["Stories", ["b"]],
    ],
  );
});

test("a collection title follows the interface language, then English, then its id", () => {
  const title = (locale: string, names: Record<string, string>) =>
    groupByCollection(
      [episode("a", "en", { id: "shelf", title: names })],
      locale,
    )[0]!.title;
  assert.equal(title("zh-CN", { zh: "书架", en: "Shelf" }), "书架");
  assert.equal(title("fr", { zh: "书架", en: "Shelf" }), "Shelf");
  assert.equal(title("en", {}), "shelf");
});

test("recordings without a usable collection share one untitled group", () => {
  const upload = { ...episode("upload", "en"), attribution: undefined };
  const malformed = episode("odd", "en", "speeches" as never);
  const groups = groupByCollection(
    [upload, episode("a", "en", speeches), malformed],
    "en",
  );
  assert.deepEqual(
    groups.map((group) => [group.id, group.episodes.map((e) => e.id)]),
    [
      [undefined, ["upload", "odd"]],
      ["speeches", ["a"]],
    ],
  );
  assert.equal(groups[0]!.title, undefined);
});

test("library rows lead with the reader's language and credit the speaker under a heading", () => {
  const rows = libraryCards(
    [
      episode("a", "en", speeches),
      episode("b", "zh", stories),
      episode("c", "en", speeches),
    ],
    "zh",
  );
  assert.deepEqual(
    rows.map((row) => [row.id, row.group?.title]),
    [
      ["b", "小说"],
      ["a", "演讲"],
      ["c", "演讲"],
    ],
  );
  assert.ok(rows[0]!.meta.startsWith("author of b"));
});

test("loose recordings get their own heading only beside titled collections", () => {
  const upload = { ...episode("upload", "en"), attribution: undefined };
  const mixed = libraryCards([episode("a", "en", speeches), upload], "en");
  assert.deepEqual(
    mixed.map((row) => [row.id, row.group?.title]),
    [
      ["a", "Speeches"],
      ["upload", "Other"],
    ],
  );
  assert.equal(libraryCards([upload], "en")[0]!.group, undefined);
});

test("every published sample names a collection the library can title", async () => {
  const read = async (file: string) => JSON.parse(await readFile(file, "utf8"));
  const collections: CollectionTitles = await read("content/collections.json");
  const specs: SampleSpec[] = [
    ...(await read("content/public-samples.json")),
    ...(await read("content/tts-samples.json")),
  ];
  const used = new Set(
    specs.map((spec) => collectionFor(spec, collections).id),
  );
  assert.deepEqual([...used].sort(), Object.keys(collections).sort());
});
