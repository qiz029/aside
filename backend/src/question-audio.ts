import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const exec = promisify(execFile);
/** Independent short-lived workspace; never truncate an overlong question into an accepted one. */
export async function normalizeQuestion(
  bytes: Uint8Array,
): Promise<Uint8Array> {
  if (!bytes.length || bytes.length > 2 * 1024 * 1024)
    throw Error("Question size limit");
  const dir = await mkdtemp(join(tmpdir(), "aside-question-"));
  try {
    const input = join(dir, "question.m4a"),
      output = join(dir, "question.wav");
    await writeFile(input, bytes);
    const { stdout } = await exec(
      "ffprobe",
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-show_entries",
        "format=duration,format_name:stream=codec_type",
        "-of",
        "json",
        input,
      ],
      { timeout: 10000, maxBuffer: 128 * 1024 },
    );
    const metadata = JSON.parse(stdout);
    const duration = Number(metadata.format?.duration);
    if (
      !String(metadata.format?.format_name).includes("mov") ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > 30 ||
      !metadata.streams?.some(
        (s: { codec_type: string }) => s.codec_type === "audio",
      )
    )
      throw Error("Question must contain at most 30 seconds of audio");
    await exec(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        input,
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-t",
        "30.1",
        "-fs",
        "1000000",
        output,
      ],
      { timeout: 15000, maxBuffer: 128 * 1024 },
    );
    const wav = await readFile(output);
    // Decode all declared duration; leave the final sample/duration checks to the shared validator.
    if (wav.length > 1000000) throw Error("Decoded question size limit");
    return wav;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
