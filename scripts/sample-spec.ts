export interface SampleSpec {
  id: string;
  sourceId: string;
  title: string;
  publisher: string;
  author: string;
  sourceUrl: string;
  audioUrl: string;
  license: string;
  licenseUrl: string;
  summary: string;
  sourceSha256: string;
  language?: string;
  languageVisibility?: string[];
  /** Key in `content/collections.json`; the shelf this sample is listed under. */
  collection: string;
  transcriptionStartMs?: number;
  transcriptionEndMs?: number;
  /** Steering text for the transcriber, e.g. to keep CJK sentence punctuation. */
  transcriptionPrompt?: string;
  excerptStartMs: number;
  excerptEndMs: number;
}

export interface TtsSampleSpec {
  id: string;
  title: string;
  author: string;
  publisher: string;
  sourceUrl: string;
  license: string;
  licenseUrl: string;
  summary: string;
  hostStyle: string;
  language?: string;
  languageVisibility?: string[];
  /** Key in `content/collections.json`; the shelf this sample is listed under. */
  collection: string;
  /** Provider voice and its presentation, used for the analysis voice fields. */
  model: string;
  voice: string;
  presentation: "masculine" | "feminine";
  /** One sentence per line, relative to the repository root. */
  textFile: string;
}

/** Audio hosts the preparation runs are allowed to download from. */
export const AUDIO_HOSTS = ["archive.org", "catalog.archives.gov"];

const REQUIRED_TEXT = [
  "title",
  "publisher",
  "author",
  "sourceUrl",
  "license",
  "licenseUrl",
  "summary",
] as const;

/**
 * Rejects a spec before anything is downloaded, synthesized or sent to a paid
 * provider. Attribution is mandatory: every published sample is credited to a
 * named source under a named licence, and a fallback would quietly credit
 * whichever source that fallback happens to name.
 */
function requireCredits(
  id: string,
  spec: Partial<Record<(typeof REQUIRED_TEXT)[number], string>>,
) {
  const missing = REQUIRED_TEXT.filter((field) => !spec[field]?.trim());
  if (missing.length)
    throw Error(
      `${id}: attribution and credits are required: ${missing.join(", ")}`,
    );
}

function requireId(id: string) {
  if (!/^[a-z][a-z0-9-]+$/.test(id)) throw Error(`Invalid sample id: ${id}`);
}

function requireVisibility(id: string, visibility?: string[]) {
  if (visibility?.length === 0)
    throw Error(
      `${id}: languageVisibility is empty; omit it to publish on the recording's own language page`,
    );
}

/** Collection titles by primary language subtag, as `content/collections.json` holds them. */
export type CollectionTitles = Record<string, Record<string, string>>;

/**
 * Every sample names its shelf, and the shelf must be titled in both interface
 * languages: the title is copied into the published episode, so a missing one
 * would surface as a bare id in whichever client asks for that language.
 */
export function collectionFor(
  spec: { id: string; collection?: string },
  collections: CollectionTitles,
) {
  const id = spec.collection?.trim();
  if (!id) throw Error(`${spec.id}: collection is required`);
  const title = collections[id];
  if (!title) throw Error(`${spec.id}: unknown collection: ${id}`);
  for (const language of ["zh", "en"])
    if (!title[language]?.trim())
      throw Error(`${spec.id}: collection ${id} has no ${language} title`);
  return { id, title };
}

export function validateSpec(spec: SampleSpec): void {
  requireId(spec.id);
  if (!/^[a-zA-Z0-9-]+$/.test(spec.sourceId))
    throw Error(`${spec.id}: invalid sourceId: ${spec.sourceId}`);
  let audio: URL;
  try {
    audio = new URL(spec.audioUrl);
  } catch {
    throw Error(`${spec.id}: invalid audioUrl: ${spec.audioUrl}`);
  }
  if (audio.protocol !== "https:" || !AUDIO_HOSTS.includes(audio.hostname))
    throw Error(`${spec.id}: unapproved audio host: ${spec.audioUrl}`);
  requireCredits(spec.id, spec);
  if (!spec.sourceSha256?.trim())
    throw Error(`${spec.id}: sourceSha256 is required`);
  requireVisibility(spec.id, spec.languageVisibility);
}

/**
 * Synthesized narration has no source audio to hash, but it does need the same
 * credits, plus the synthesis settings and a text file inside the repository.
 */
export function validateTtsSpec(spec: TtsSampleSpec): void {
  requireId(spec.id);
  requireCredits(spec.id, spec);
  if (!spec.hostStyle?.trim()) throw Error(`${spec.id}: hostStyle is required`);
  if (!spec.model?.trim() || !spec.voice?.trim())
    throw Error(`${spec.id}: model and voice are required`);
  if (spec.presentation !== "masculine" && spec.presentation !== "feminine")
    throw Error(`${spec.id}: presentation must be masculine or feminine`);
  if (
    !spec.textFile?.startsWith("content/texts/") ||
    spec.textFile.includes("..")
  )
    throw Error(`${spec.id}: textFile must live under content/texts/`);
  requireVisibility(spec.id, spec.languageVisibility);
}
