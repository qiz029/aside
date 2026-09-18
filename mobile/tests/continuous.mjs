/** One local native run: PORT=4342 MAESTRO=... node mobile/tests/continuous.mjs ios DEVICE */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const [platform, device] = process.argv.slice(2);
assert.ok(
  ["ios", "android"].includes(platform) && device,
  "Supply platform and simulator ID",
);
const base = `http://127.0.0.1:${Number(process.env.PORT ?? 4311)}/__fixture`;
const run = Date.now();
const question = `What is a biography ${run}?`,
  answer = `A life story ${run}.`;
const before = new Set((await (await fetch(`${base}/voice`)).json()).sessions);
let done = false,
  failed = false;
const child = spawn(
  process.env.MAESTRO ?? "maestro",
  [
    "--device",
    device,
    "test",
    "-e",
    `QUESTION=${question}`,
    "-e",
    `ANSWER=${answer}`,
    "mobile/tests/continuous.yaml",
  ],
  { stdio: "inherit" },
);
const exit = new Promise((resolve) =>
  child.on("exit", (code) => {
    done = true;
    failed = code !== 0;
    resolve();
  }),
);
async function samples() {
  return (
    (await (await fetch(`${base}/device`)).json())[platform]?.filter(
      (s) => s.at >= run,
    ) ?? []
  );
}
async function waitFor(label, get, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await get();
    if (result) return result;
    if (failed) throw Error(`Maestro failed during ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error(`Timed out: ${label}`);
}
try {
  const sessionId = await waitFor(
    "ready duplex",
    async () => {
      const ids = (await (await fetch(`${base}/voice`)).json()).sessions;
      const id = ids.find((id) => !before.has(id));
      const s = (await samples()).at(-1);
      return id && s?.diagnostics.status === "on" && s.player.playing
        ? id
        : undefined;
    },
    180000,
  );
  const response = await fetch(`${base}/voice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: process.env.VARIANT === "1" ? "variant" : "question",
      sessionId,
      text: question,
      answer,
    }),
  });
  assert.equal(response.status, 200);
  const transport = await response.json();
  assert.ok(transport.inputFrames > 0, "actual input media reaches RTC");
  let replaySent = false;
  await waitFor(
    "native answer drain and resume",
    async () => {
      const evidence = await samples();
      const countdown = evidence.find(
        (s) =>
          s.resumeSeconds !== null && s.history.some((t) => t.text === answer),
      );
      if (!countdown) return false;
      assert.equal(
        countdown.player.playing,
        false,
        "podcast remains paused during follow-up window",
      );
      assert.equal(
        countdown.diagnostics.voice?.audio?.lastDrain?.drained,
        true,
        "native PCM drained before countdown",
      );
      assert.equal(countdown.diagnostics.voice?.audio?.active, false);
      if (!replaySent) {
        replaySent = true;
        const replay = await fetch(`${base}/voice`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "duplicate",
            sessionId,
            answer: `Unrequested replay ${run}.`,
          }),
        });
        assert.equal(replay.status, 200);
      }
      return evidence.find(
        (s) =>
          s.at > countdown.at &&
          s.player.playing &&
          s.diagnostics.status === "on",
      );
    },
    20000,
  );
  await exit;
  assert.equal(failed, false);
  if (process.env.EXTENDED === "1") {
    const action = async (value) => {
      const response = await fetch(`${base}/voice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, ...value }),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const beforeIgnore = (await samples()).at(-1);
    await action({ action: "ignore", text: `Talking to a neighbour ${run}` });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const ignored = (await samples()).at(-1);
    assert.equal(ignored.player.playing, true);
    assert.equal(ignored.player.volume, 1);
    assert.deepEqual(
      ignored.history,
      beforeIgnore.history,
      "ignored speech must not enter history",
    );

    const first = `Follow-up one ${run}`,
      second = `Follow-up two ${run}`;
    const short = `The first follow-up answer ${run}.`;
    const long = (
      `The second follow-up answer ${run}. ` +
      "A biography records the experiences and decisions of a person's life. ".repeat(
        8,
      )
    ).trim();
    await action({ action: "question", text: first, answer: short });
    const held = await waitFor(
      "first follow-up countdown",
      async () => {
        const s = (await samples()).at(-1);
        return s?.resumeSeconds !== null &&
          s?.history.some((t) => t.text === short)
          ? s
          : false;
      },
      12000,
    );
    const anchor = held.interruption;
    await action({ action: "question", text: second, answer: long });
    const longWait = await waitFor(
      "long-answer countdown",
      async () => {
        const s = (await samples()).at(-1);
        return s?.resumeSeconds !== null &&
          s?.history.some((t) => t.text === long)
          ? s
          : false;
      },
      12000,
    );
    assert.deepEqual(
      longWait.interruption,
      anchor,
      "follow-ups retain the original semantic anchor",
    );
    assert.ok(
      longWait.resumeSeconds >= 7,
      "long answers leave an eight-second follow-up window",
    );
    const resumed = await waitFor(
      "long-answer resume with live microphone",
      async () => {
        const s = (await samples()).at(-1);
        return s?.player.playing &&
          s?.at > longWait.at &&
          s?.diagnostics.status === "on"
          ? s
          : false;
      },
      15000,
    );
    assert.ok(resumed.at - longWait.at >= 7500);
    for (const text of [first, short, second, long])
      assert.ok(resumed.history.some((t) => t.text === text));
  }
  const evidence = await samples();
  assert.ok(replaySent);
  assert.ok(
    !evidence.some((s) =>
      s.history.some((t) => t.text.includes(`Unrequested replay ${run}`)),
    ),
    "a duplicate backend delegation cannot reopen the completed answer or enter history",
  );
  assert.ok(
    evidence.some((s) => s.diagnostics.voice?.audio?.active),
    "actual answer playout was observed",
  );
  assert.ok(evidence.some((s) => s.history.some((t) => t.text === question)));
  assert.ok(
    !evidence.some(
      (s) => s.diagnostics.voice?.audio?.active && s.player.playing,
    ),
    "podcast and admitted answer never overlap",
  );
  const output =
    process.env.EVIDENCE ?? `/tmp/aside-continuous-${platform}-native.json`;
  await writeFile(
    output,
    JSON.stringify(
      {
        platform,
        run,
        sessionId,
        question,
        answer,
        transport,
        samples: evidence,
      },
      null,
      2,
    ),
  );
  console.log(`Native continuous acceptance passed. Evidence: ${output}`);
} finally {
  if (!done) child.kill("SIGTERM");
}
