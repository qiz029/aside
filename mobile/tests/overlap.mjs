/**
 * Characterize extra supplier audio during an unfinished admitted reply.
 * Run after continuous.mjs, while that fixture session remains connected.
 * Safeguards can pass while extraWasHeard remains true: that is a documented
 * transport limitation, NOT a successful duplicate-suppression assertion.
 */
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
const [file, device] = process.argv.slice(2);
assert.ok(
  file && device,
  "Supply the continuous.mjs evidence file and device ID",
);
const { platform, sessionId } = JSON.parse(await readFile(file, "utf8"));
const base = `http://127.0.0.1:${Number(process.env.PORT ?? 4311)}/__fixture`;
const run = Date.now();
const question = `Overlapping reply probe ${run}?`;
const answer = `The admitted answer ${run}.`;
const duplicate = ` Unrequested additional speech ${run}.`;
async function samples() {
  return (
    (await (await fetch(`${base}/device`)).json())[platform] ?? []
  ).filter((s) => s.at >= run);
}
async function waitFor(label, check, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check(await samples());
    if (result) return result;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error(`Timed out: ${label}`);
}
async function action(body) {
  const result = await fetch(`${base}/voice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, ...body }),
  });
  assert.equal(result.status, 200);
  return result.json();
}
await action({ action: "question", text: question, answer });
const active = await waitFor(
  "unfinished admitted native audio",
  (s) => s.at(-1)?.diagnostics.voice?.audio?.active && s.at(-1),
);
assert.equal(active.player.playing, false);
assert.equal(active.resumeSeconds, null);
await action({ action: "duplicate", answer: duplicate });
await waitFor(
  "ambiguous audio drained",
  (s) => s.at(-1)?.diagnostics.voice?.audio?.drained && s.at(-1),
);
await new Promise((r) => setTimeout(r, 4000));
const ambiguous = (await samples()).at(-1);
assert.equal(
  ambiguous.player.playing,
  false,
  "Ambiguous answer must not resume the programme",
);
assert.equal(ambiguous.resumeSeconds, null);
assert.equal(ambiguous.diagnostics.status, "on");
const extraWasHeard = ambiguous.history.some((t) =>
  t.text.includes(duplicate.trim()),
);
const directory = await mkdtemp(join(tmpdir(), "aside-overlap-"));
const flow = join(directory, "confirmation.yaml");
await writeFile(
  flow,
  'appId: com.asidefm.app.dev\n---\n- assertVisible: "Podcast paused. Ask another question or tap Continue."\n- assertVisible: "Continue"\n- takeScreenshot: overlapping-reply-confirmation\n',
);
try {
  const child = spawn(
    process.env.MAESTRO ?? "maestro",
    ["--device", device, "test", flow],
    { stdio: "inherit" },
  );
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(
    code,
    0,
    "Ambiguous completion must expose a visible manual continuation action",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
const next = `A genuine next question ${run}?`;
const nextAnswer = `A fresh answer ${run}.`;
await action({ action: "question", text: next, answer: nextAnswer });
const countdown = await waitFor(
  "genuine follow-up drains and counts down",
  (s) =>
    s.at(-1)?.resumeSeconds !== null &&
    s.at(-1)?.history.some((t) => t.text === nextAnswer) &&
    s.at(-1),
);
assert.deepEqual(countdown.interruption, ambiguous.interruption);
await waitFor(
  "genuine follow-up resumes with microphone retained",
  (s) => s.at(-1)?.player.playing && s.at(-1)?.diagnostics.status === "on",
);
const evidence = await samples();
assert.ok(
  !evidence.some((s) => s.player.playing && s.diagnostics.voice?.audio?.active),
);
const output =
  process.env.EVIDENCE ?? join(tmpdir(), `aside-${platform}-overlap.json`);
await writeFile(
  output,
  JSON.stringify(
    {
      platform,
      run,
      duplicateInjectedWhileNativeActive: true,
      extraWasHeard,
      automaticResumePrevented: true,
      subsequentFollowupRecovered: true,
      samples: evidence,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    output,
    extraWasHeard,
    automaticResumePrevented: true,
    subsequentFollowupRecovered: true,
  }),
);
