import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sendRemainingParts,
  type UploadJournal,
} from "../mobile/src/upload-journal.js";

test("a failed upload survives process restart and only resends unacknowledged parts", async () => {
  let stored = "";
  const journal: UploadJournal = {
    id: "same-upload",
    partSize: 8,
    file: {
      uri: "file:///audio",
      name: "audio",
      mimeType: "audio/mpeg",
      size: 20,
    },
    parts: [],
  };
  const persist = async (value: UploadJournal) => {
    stored = JSON.stringify(value);
  };
  await assert.rejects(
    sendRemainingParts(
      journal,
      async (n) => {
        if (n === 2) throw Error("network lost");
        return { etag: "one" };
      },
      persist,
      () => {},
    ),
    /network lost/,
  );
  const restored: UploadJournal = JSON.parse(stored);
  assert.equal(restored.id, "same-upload");
  const sent: number[][] = [];
  await sendRemainingParts(
    restored,
    async (n, offset, length) => {
      sent.push([n, offset, length]);
      return { etag: String(n) };
    },
    persist,
    () => {},
  );
  assert.deepEqual(sent, [
    [2, 8, 8],
    [3, 16, 4],
  ]);
  assert.deepEqual(
    restored.parts.map((x) => x.partNumber),
    [1, 2, 3],
  );
});
test("retrying an acknowledged final part does not upload any audio again", async () => {
  const journal: UploadJournal = {
    id: "completed",
    partSize: 8,
    file: {
      uri: "file:///audio",
      name: "audio",
      mimeType: "audio/mpeg",
      size: 8,
    },
    parts: [{ partNumber: 1, etag: "saved" }],
  };
  await sendRemainingParts(
    journal,
    async () => {
      throw Error("must not resend");
    },
    async () => {},
    (value) => assert.equal(value, 1),
  );
});
