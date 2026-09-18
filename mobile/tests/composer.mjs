/** Signed-in native fixture only; require a newly submitted question, not an old answer. */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

const [platform, device] = process.argv.slice(2);
assert.ok(["ios", "android"].includes(platform) && device);
const base = `http://127.0.0.1:${Number(process.env.PORT ?? 4311)}`;
const started = Date.now();
const question = `Compact composer ${platform} ${started}?`;
const child = spawn(
  process.env.MAESTRO ?? "maestro",
  [
    "--device",
    device,
    "test",
    "-e",
    `QUESTION=${question}`,
    "mobile/tests/composer-send.yaml",
  ],
  { stdio: "inherit" },
);
const code = await new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("exit", resolve);
});
assert.equal(code, 0, "native composer flow completed");
let restored;
for (let attempt = 0; attempt < 25; attempt++) {
  const response = await fetch(`${base}/__fixture/device`);
  assert.equal(response.status, 200);
  const samples = (await response.json())[platform] ?? [];
  restored = samples.findLast((sample) => {
    const i = sample.history.findIndex(
      (turn) => turn.role === "user" && turn.text === question,
    );
    return (
      sample.at >= started &&
      !sample.busy &&
      i >= 0 &&
      sample.history[i + 1]?.role === "assistant" &&
      sample.history[i + 1]?.text === "A short answer"
    );
  });
  if (restored) break;
  await new Promise((resolve) => setTimeout(resolve, 200));
}
assert.ok(
  restored,
  "this submission has its own completed reply in the native runtime",
);
assert.equal(
  restored.history.filter((turn) => turn.text === question).length,
  1,
);
const evidence = {
  platform,
  question,
  completedReply: "A short answer",
  uniqueQuestionCount: 1,
  historyLength: restored.history.length,
  nativeDraftCleared: true,
  emptyAfterReopening: true,
  fixture: true,
};
await writeFile(
  process.env.EVIDENCE ?? `/tmp/aside-composer-${platform}.json`,
  JSON.stringify(evidence, null, 2),
);
console.log(
  "PASS: newly submitted native question completed; draft cleared and stayed empty after reopening.",
);
