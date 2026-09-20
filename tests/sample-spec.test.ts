import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUDIO_HOSTS,
  collectionFor,
  validateSpec,
  validateTtsSpec,
  type SampleSpec,
  type TtsSampleSpec,
} from "../scripts/sample-spec";

function spec(overrides: Partial<SampleSpec> = {}): SampleSpec {
  return {
    id: "sample-one",
    sourceId: "source-one",
    title: "Title",
    publisher: "Publisher",
    author: "Author",
    sourceUrl: "https://example.test/source",
    audioUrl: `https://${AUDIO_HOSTS[0]}/download/source-one.mp3`,
    license: "Public domain",
    licenseUrl: "https://example.test/license",
    summary: "Summary",
    collection: "shelf",
    sourceSha256: "0".repeat(64),
    excerptStartMs: 0,
    excerptEndMs: 1000,
    ...overrides,
  };
}

function ttsSpec(overrides: Partial<TtsSampleSpec> = {}): TtsSampleSpec {
  return {
    id: "synthesized-one",
    title: "Title",
    author: "Author",
    publisher: "Publisher",
    sourceUrl: "https://example.test/source",
    license: "Public domain text",
    licenseUrl: "https://example.test/license",
    summary: "Summary",
    collection: "shelf",
    hostStyle: "Steady narration.",
    model: "tts-1",
    voice: "nova",
    presentation: "feminine",
    textFile: "content/texts/synthesized-one.txt",
    ...overrides,
  };
}

test("a complete synthesized sample passes and still needs every credit", () => {
  assert.doesNotThrow(() => validateTtsSpec(ttsSpec()));
  for (const field of [
    "title",
    "publisher",
    "author",
    "sourceUrl",
    "license",
    "licenseUrl",
    "summary",
  ] as const)
    assert.throws(
      () => validateTtsSpec(ttsSpec({ [field]: "" })),
      new RegExp(field),
      `${field} should be required`,
    );
});

test("synthesis settings and the text path are checked, not assumed", () => {
  assert.throws(
    () => validateTtsSpec(ttsSpec({ hostStyle: "  " })),
    /hostStyle/,
  );
  assert.throws(
    () => validateTtsSpec(ttsSpec({ voice: "" })),
    /model and voice/,
  );
  assert.throws(
    () => validateTtsSpec(ttsSpec({ presentation: "unknown" as "feminine" })),
    /presentation must be/,
  );
  for (const textFile of [
    "/etc/passwd",
    "content/texts/../secret.txt",
    "texts/a.txt",
  ])
    assert.throws(
      () => validateTtsSpec(ttsSpec({ textFile })),
      /textFile must live under content\/texts\//,
      textFile,
    );
  assert.throws(
    () => validateTtsSpec(ttsSpec({ languageVisibility: [] })),
    /languageVisibility is empty/,
  );
});
test("a fully credited spec on an approved host passes", () => {
  for (const host of AUDIO_HOSTS)
    assert.doesNotThrow(() =>
      validateSpec(spec({ audioUrl: `https://${host}/x.mp3` })),
    );
});

test("every credit is required, and the error names the missing ones", () => {
  for (const field of [
    "title",
    "publisher",
    "author",
    "sourceUrl",
    "license",
    "licenseUrl",
    "summary",
    "sourceSha256",
  ] as const) {
    const blank = { ...spec(), [field]: "" };
    assert.throws(
      () => validateSpec(blank),
      new RegExp(field),
      `${field} should be required`,
    );
  }
});

test("whitespace does not count as a credit", () => {
  assert.throws(
    () => validateSpec(spec({ publisher: "   ", license: "\t" })),
    /publisher, license/,
  );
});

test("only https on an approved host is downloaded", () => {
  for (const audioUrl of [
    "https://example.test/x.mp3",
    "https://voa-audio.voanews.eu/x.mp3",
    `http://${AUDIO_HOSTS[0]}/x.mp3`,
    `ftp://${AUDIO_HOSTS[0]}/x.mp3`,
  ])
    assert.throws(
      () => validateSpec(spec({ audioUrl })),
      /unapproved audio host/,
      audioUrl,
    );
});

test("a malformed url names the spec instead of throwing a bare TypeError", () => {
  assert.throws(() => validateSpec(spec({ audioUrl: "not a url" })), {
    message: /sample-one: invalid audioUrl/,
  });
});

test("an empty visibility list is rejected, an omitted one is not", () => {
  assert.throws(
    () => validateSpec(spec({ languageVisibility: [] })),
    /languageVisibility is empty/,
  );
  assert.doesNotThrow(() =>
    validateSpec(spec({ languageVisibility: ["en", "zh-cn"] })),
  );
});

test("ids and source ids that cannot be published are rejected", () => {
  assert.throws(
    () => validateSpec(spec({ id: "Upper-Case" })),
    /Invalid sample id/,
  );
  assert.throws(
    () => validateSpec(spec({ sourceId: "has.dots" })),
    /invalid sourceId/,
  );
});

test("a sample must name a collection titled in both interface languages", () => {
  const collections = {
    shelf: { zh: "书架", en: "Shelf" },
    half: { zh: "半个" },
  };
  assert.deepEqual(collectionFor(spec(), collections), {
    id: "shelf",
    title: { zh: "书架", en: "Shelf" },
  });
  assert.throws(
    () => collectionFor(spec({ collection: " " }), collections),
    /collection is required/,
  );
  assert.throws(
    () => collectionFor(spec({ collection: "missing" }), collections),
    /unknown collection: missing/,
  );
  assert.throws(
    () => collectionFor(spec({ collection: "half" }), collections),
    /has no en title/,
  );
});
