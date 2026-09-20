import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { AudioProvider } from "../backend/src/audio-provider.js";
import { makeAnalysis } from "@aside/engine/server";
import {
  collectionFor,
  validateTtsSpec,
  type CollectionTitles,
  type TtsSampleSpec,
} from "./sample-spec.js";
import { writeSeedSql } from "./seed-sql.js";
import type { Episode, Passage, Speaker } from "@aside/engine/core";

const exec = promisify(execFile);
const dir = ".wrangler/public-samples";
const cache = ".wrangler/tts-cache";
const specs: TtsSampleSpec[] = JSON.parse(
  await readFile("content/tts-samples.json", "utf8"),
);
const collections: CollectionTitles = JSON.parse(
  await readFile("content/collections.json", "utf8"),
);
const provider = new AudioProvider(process.env.OPENAI_API_KEY!);
const duration = async (file: string) =>
  Math.round(
    Number(
      (
        await exec("ffprobe", [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "csv=p=0",
          file,
        ])
      ).stdout,
    ) * 1000,
  );

await mkdir(dir, { recursive: true });
await mkdir(cache, { recursive: true });
for (const spec of specs) {
  if (
    process.env.SAMPLE_IDS &&
    !process.env.SAMPLE_IDS.split(",").includes(spec.id)
  )
    continue;
  validateTtsSpec(spec);
  const collection = collectionFor(spec, collections);
  const language = spec.language ?? "zh";
  const sentences = (await readFile(spec.textFile, "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (sentences.length < 5)
    throw Error(`${spec.id}: a sample needs at least five sentences`);

  // One provider call per sentence, cached by the exact text and voice, so the
  // transcript offsets are the real boundaries of what was spoken.
  const passages: Passage[] = [];
  const parts: string[] = [];
  let offset = 0;
  for (const [index, text] of sentences.entries()) {
    const digest = createHash("sha256")
      .update(`${spec.model}|${spec.voice}|${text}`)
      .digest("hex")
      .slice(0, 16);
    const part = `${cache}/${digest}.mp3`;
    // A cached part is only trusted once ffprobe reads a duration from it, so
    // an interrupted run cannot pin offsets to a truncated file. Synthesis
    // lands through a rename for the same reason.
    let length = 0;
    try {
      length = await duration(part);
    } catch {
      length = 0;
    }
    if (length <= 0) {
      const speech = await provider.client.audio.speech.create({
        model: spec.model,
        voice: spec.voice,
        input: text,
        response_format: "mp3",
      });
      const staged = `${part}.tmp`;
      await writeFile(staged, Buffer.from(await speech.arrayBuffer()));
      await rename(staged, part);
      length = await duration(part);
      if (length <= 0)
        throw Error(`${spec.id}: the provider returned no audio for: ${text}`);
    }
    passages.push({
      id: `p-${index}`,
      startMs: offset,
      endMs: offset + length,
      text,
      speaker: "narrator",
    });
    offset += length;
    parts.push(part);
    console.log(
      `  ${spec.id} ${index + 1}/${sentences.length} ${(length / 1000).toFixed(1)}s`,
    );
  }
  if (offset > 300000)
    throw Error(`${spec.id}: ${offset}ms exceeds the five minute limit`);

  const list = `${cache}/${spec.id}.txt`;
  // The concat demuxer resolves relative entries against the list file, not the
  // working directory, so the parts have to be absolute paths.
  await writeFile(
    list,
    parts.map((part) => `file '${resolve(part)}'`).join("\n") + "\n",
  );
  const audioFile = `${dir}/${spec.id}.mp3`;
  await exec("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-codec:a",
    "libmp3lame",
    "-b:a",
    "96k",
    audioFile,
  ]);

  // The offsets come from the parts, so the assembled file has to agree with
  // them: encoder delay or a re-encode that drops samples would otherwise
  // shift every resume anchor without any visible failure.
  const assembled = await duration(audioFile);
  if (Math.abs(assembled - offset) > 200)
    throw Error(
      `${spec.id}: assembled audio is ${assembled}ms but the sentences total ${offset}ms`,
    );

  const speaker: Speaker = {
    id: "narrator",
    presentation: spec.presentation,
    durationMs: offset,
    confidence: 1,
  };
  const analysis = makeAnalysis(passages, {
    summary: spec.summary,
    hostStyle: spec.hostStyle,
    speakers: [speaker],
    groups: passages.map((passage) => ({
      firstId: passage.id,
      lastId: passage.id,
    })),
  });
  // Nothing was transcribed or acoustically reviewed: the narration and its
  // timings both come from the synthesis above.
  analysis.source = "synthesis";

  const episode: Episode = {
    id: spec.id,
    title: spec.title,
    createdAt: new Date().toISOString(),
    durationMs: offset,
    mimeType: "audio/mpeg",
    status: "ready",
    stage: "合成语音 · 按句对齐",
    progress: 1,
    attribution: {
      publisher: spec.publisher,
      author: spec.author,
      sourceUrl: spec.sourceUrl,
      licenseUrl: spec.licenseUrl,
      license: spec.license,
      language,
      languageVisibility: spec.languageVisibility ?? [language],
      collection,
      excerptStartMs: 0,
      excerptEndMs: offset,
    },
    analysis,
  };
  await writeFile(`${dir}/${spec.id}.json`, JSON.stringify(episode, null, 2));
  await writeSeedSql(dir, episode);
  console.log(
    JSON.stringify({
      id: spec.id,
      sentences: passages.length,
      durationMs: offset,
      voice: `${spec.model}/${spec.voice}`,
      sha256: createHash("sha256")
        .update(await readFile(audioFile))
        .digest("hex"),
    }),
  );
}
