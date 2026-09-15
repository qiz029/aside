import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
const root = resolve(import.meta.dirname, "..");
const credentials = resolve(root, ".credentials");
await mkdir(credentials, { recursive: true, mode: 0o700 });
const path = resolve(credentials, "android.json"),
  keystore = resolve(credentials, "internal.keystore");
let config;
try {
  config = JSON.parse(await readFile(path, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  config = { password: randomBytes(32).toString("hex") };
  await writeFile(path, JSON.stringify(config), { mode: 0o600, flag: "wx" });
}
const env = {
  ...process.env,
  APP_VARIANT: process.env.APP_VARIANT ?? "production",
  ASIDE_ANDROID_KEYSTORE: keystore,
  ASIDE_ANDROID_STORE_PASSWORD: config.password,
};
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
try {
  await access(keystore);
} catch {
  run("keytool", [
    "-genkeypair",
    "-keystore",
    keystore,
    "-storepass:env",
    "ASIDE_ANDROID_STORE_PASSWORD",
    "-keypass:env",
    "ASIDE_ANDROID_STORE_PASSWORD",
    "-alias",
    "aside-internal",
    "-keyalg",
    "RSA",
    "-keysize",
    "2048",
    "-validity",
    "10000",
    "-dname",
    "CN=Aside Internal",
  ]);
}
run("npx", ["expo", "prebuild", "--platform", "android", "--no-install"]);
run(
  "./gradlew",
  [
    "assembleRelease",
    ...(env.ASIDE_ANDROID_ARCHITECTURES
      ? [`-PreactNativeArchitectures=${env.ASIDE_ANDROID_ARCHITECTURES}`]
      : []),
  ],
  resolve(root, "android"),
);
console.log(
  "APK: " +
    resolve(root, "android/app/build/outputs/apk/release/app-release.apk"),
);
