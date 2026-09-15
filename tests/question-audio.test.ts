import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { normalizeQuestion } from "../backend/src/question-audio.js";
const validateWav = (bytes: Uint8Array) => {
  assert.equal(Buffer.from(bytes).toString("ascii", 0, 4), "RIFF");
  assert.ok(bytes.length > 44 && bytes.length < 1000000);
};
import { mediaApp } from "../backend/src/container/app.js";
test("native M4A question is decoded and served as bounded PCM; invalid and overlong inputs fail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aside-native-question-test-"));
  const app = mediaApp(dir);
  try {
    const file = join(dir, "question.m4a");
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=400:duration=1",
      "-c:a",
      "aac",
      file,
    ]);
    const bytes = await readFile(file);
    const wav = await normalizeQuestion(bytes);
    validateWav(wav);
    const response = await app.inject({
      method: "POST",
      url: "/question",
      headers: { "content-type": "application/octet-stream" },
      payload: bytes,
    });
    assert.equal(response.statusCode, 200, response.body);
    validateWav(response.rawPayload);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/question",
          headers: { "content-type": "application/octet-stream" },
          payload: "invalid",
        })
      ).statusCode,
      422,
    );
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=400:duration=31",
      "-c:a",
      "aac",
      file,
    ]);
    await assert.rejects(() =>
      normalizeQuestion(new Uint8Array(2 * 1024 * 1024 + 1)),
    );
    await assert.rejects(() => readFile(file).then(normalizeQuestion));
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
