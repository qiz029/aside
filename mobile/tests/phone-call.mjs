/** Android emulator telephony interruption after continuous.mjs. No real call. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const [file, device] = process.argv.slice(2);
assert.ok(
  file && /^emulator-\d+$/.test(device ?? ""),
  "Supply setup evidence and an Android emulator ID",
);
const { platform, sessionId } = JSON.parse(await readFile(file, "utf8"));
assert.equal(platform, "android");
const base = `http://127.0.0.1:${Number(process.env.PORT ?? 4311)}/__fixture`;
const rtc = `http://127.0.0.1:${Number(process.env.RTC_PORT ?? 4312)}/control`;
const run = Date.now(),
  phone = "5551234567";
const evidence = { run, platform, emulatedCall: true };
const adb = async (...args) =>
  (
    await exec(process.env.ADB ?? "adb", ["-s", device, ...args], {
      timeout: 20000,
      maxBuffer: 2 ** 20,
    })
  ).stdout;
async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, ...body }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function latest() {
  return (await (await fetch(`${base}/device`)).json()).android?.at(-1);
}
function recordings(dump) {
  return (
    dump
      .split("RecordActivityMonitor dump time:")[1]
      ?.split("Audio event log:")[0] ?? ""
  );
}
async function waitFor(label, check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const sample = await latest();
    if (sample && (await check(sample))) return sample;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error(`Timed out: ${label}`);
}
try {
  await post(`${base}/voice`, {
    action: "question",
    text: `Call interruption ${run}?`,
    answer: `The answer before the call ${run}.`,
  });
  // Keep the synthetic output audible long enough for the OS telephony event;
  // no additional transcript or backend answer is introduced by this extension.
  await post(rtc, { action: "answer", text: "", duration: 10 });
  evidence.before = await waitFor(
    "audible answer",
    (s) =>
      s.at >= run && s.diagnostics.voice?.audio?.active && !s.player.playing,
  );
  evidence.audioBefore = await adb("shell", "dumpsys", "audio");
  assert.match(
    recordings(evidence.audioBefore),
    /active\? true[\s\S]*pack:com\.asidefm\.app\.dev/,
    "the OS must confirm a real active recorder before the call",
  );
  evidence.callStartedAt = Date.now();
  evidence.callResult = await adb("emu", "gsm", "call", phone);
  await waitFor("emulated incoming call registered", async () => {
    evidence.callRegistry = await adb("shell", "dumpsys", "telephony.registry");
    return (
      /^\s*mCallState=1$/m.test(evidence.callRegistry) &&
      evidence.callRegistry.includes(`mCallIncomingNumber=${phone}`)
    );
  });
  evidence.interrupted = await waitFor(
    "capture stopped",
    (s) =>
      s.at >= evidence.callStartedAt &&
      !s.diagnostics.active &&
      !s.diagnostics.voice &&
      !s.player.playing &&
      s.resumeSeconds === null,
  );
  evidence.audioDuringCall = await adb("shell", "dumpsys", "audio");
  assert.doesNotMatch(
    recordings(evidence.audioDuringCall),
    /pack:com\.asidefm\.app\.dev/,
    "Android AudioService must release the recorder, not just hide the recording UI",
  );
  evidence.callCanceled = await adb("emu", "gsm", "cancel", phone);
  await waitFor("call ended", async () =>
    /^\s*mCallState=0$/m.test(
      await adb("shell", "dumpsys", "telephony.registry"),
    ),
  );
  await adb(
    "shell",
    "monkey",
    "-p",
    "com.asidefm.app.dev",
    "-c",
    "android.intent.category.LAUNCHER",
    "1",
  );
  const foregroundAt = Date.now();
  evidence.returned = await waitFor(
    "foreground remains paused with microphone off",
    (s) =>
      s.at >= foregroundAt &&
      !s.diagnostics.active &&
      !s.diagnostics.voice &&
      !s.player.playing &&
      s.resumeSeconds === null,
  );
  assert.deepEqual(
    evidence.returned.interruption,
    evidence.before.interruption,
    "the listening anchor survives the call",
  );
  assert.ok(
    evidence.returned.history.some(
      (t) => t.role === "user" && t.text === `Call interruption ${run}?`,
    ),
  );
  // Outlast the normal follow-up window: returning must not reopen capture or
  // resume a canceled reply when an old timer would have fired.
  evidence.afterReturn = [];
  while (Date.now() - foregroundAt < 4000) {
    const sample = await latest();
    evidence.afterReturn.push(sample);
    assert.equal(sample.diagnostics.active, false);
    assert.equal(sample.player.playing, false);
    assert.equal(sample.resumeSeconds, null);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await waitFor(
    "supplier session released",
    async () =>
      !(await (await fetch(`${base}/voice`)).json()).sessions.includes(
        sessionId,
      ),
  );
  evidence.passed = true;
} catch (error) {
  evidence.error = String(error);
  evidence.latest = await latest().catch(() => undefined);
  throw error;
} finally {
  await adb("emu", "gsm", "cancel", phone).catch(() => {});
  await writeFile(
    process.env.EVIDENCE ?? "/tmp/aside-android-phone-call.json",
    JSON.stringify(evidence, null, 2),
  );
}
console.log(
  "Android emulator call interruption passed; no real telephony or model request.",
);
