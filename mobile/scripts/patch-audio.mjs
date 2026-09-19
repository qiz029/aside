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

// SDK 54 resets the mode only when category options are empty. Recording uses
// Bluetooth options, so a previous WebRTC .voiceChat mode otherwise survives.
const modulePath = join(dirname(path), "AudioModule.swift");
let moduleSource = await readFile(modulePath, "utf8");
const modeBefore = "try session.setCategory(category, options: sessionOptions)";
const modeAfter =
  "try session.setCategory(category, mode: .default, options: sessionOptions)";
if (moduleSource.includes(modeBefore))
  moduleSource = moduleSource.replace(modeBefore, modeAfter);
else if (!moduleSource.includes(modeAfter))
  throw Error(
    "Review the expo-audio recording mode reset after upgrading the SDK.",
  );

// HFP moves the podcast and the answer onto the call-quality link for the whole
// listening lease, and cars present it as a phone call. A2DP alone keeps the
// output route and leaves the built-in microphone as the only Bluetooth-era input.
const routeBefore = `#if compiler(>=6.2) // Xcode 26
        categoryOptions.insert(.allowBluetoothHFP)
#else
        categoryOptions.insert(.allowBluetooth)
#endif`;
const routeAfter = "        categoryOptions.insert(.allowBluetoothA2DP)";
if (moduleSource.includes(routeBefore))
  moduleSource = moduleSource.replace(routeBefore, routeAfter);
else if (!moduleSource.includes(routeAfter))
  throw Error(
    "Review the expo-audio Bluetooth route options after upgrading the SDK.",
  );
await writeFile(modulePath, moduleSource);
