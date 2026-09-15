/** SDK 54 backport of expo/expo#44974: paused Now Playing time must not advance. */
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
let path;
try {
  path = join(
    dirname(require.resolve("expo-audio/package.json")),
    "ios/MediaController.swift",
  );
} catch (error) {
  if (error.code === "MODULE_NOT_FOUND") process.exit(0); // Backend-only installation.
  throw error;
}
const source = await readFile(path, "utf8");
const before = "player.isPlaying ? player.ref.rate : 1.0";
const after = "player.isPlaying ? player.ref.rate : 0.0";
if (source.includes(before))
  await writeFile(path, source.replace(before, after));
else if (!source.includes(after))
  throw Error(
    "Review the expo-audio Now Playing backport after upgrading the SDK.",
  );
