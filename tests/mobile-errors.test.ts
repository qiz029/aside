import { test } from "node:test";
import assert from "node:assert/strict";
import { errorMessage } from "../mobile/src/error-message.js";

test("English recovery messages retain the actual native audio failure", () => {
  const raw =
    "Caused by: failed to change audio state: session activation failed。可以继续听节目，或重新尝试提问。";
  assert.match(errorMessage(raw, "en"), /audio session couldn't start/);
  assert.match(errorMessage(raw, "zh"), /音频会话未能启动/);
});
test("an untranslated recovery hint cannot hide a useful English cause", () => {
  assert.equal(
    errorMessage(
      "Error: Audio input unavailable。可以继续听节目，或重新尝试提问。",
      "en",
    ),
    "Audio input unavailable",
  );
  assert.equal(
    errorMessage("测试 / Voice connection rejected。可以继续听节目。", "en"),
    "Voice connection rejected",
  );
  assert.equal(
    errorMessage("音频已被系统中断 / Audio was interrupted", "zh"),
    "音频已被系统中断",
  );
});
