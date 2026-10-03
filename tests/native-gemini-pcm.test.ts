import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("iOS packet enqueue and hardware render preserve held PCM, discard and bounded overflow", () => {
  const dir = mkdtempSync(join(tmpdir(), "aside-gemini-pcm-"));
  try {
    const source = join(dir, "trace.c"),
      binary = join(dir, "trace");
    writeFileSync(
      source,
      `
#include <assert.h>
#include "AsidePcmQueue.h"
int main(void) {
  AsidePcmQueue q; assert(AsidePcmInit(&q, 1000, 1));
  int16_t input[] = {0, 1, 2, 1000, 2000}, output[8];
  AsidePcmCommand(&q, AsideHold);
  AsidePcmEnqueue(&q, input, 5);
  AsidePcmRender(&q, output, 3);
  assert(q.size == 5 && output[0] == 0 && output[2] == 0);
  AsidePcmCommand(&q, AsidePlay);
  AsidePcmRender(&q, output, 3);
  assert(output[0] == 0 && output[1] == 1 && output[2] == 2);
  AsidePcmRender(&q, output, 3);
  assert(output[0] == 1000 && output[1] == 2000 && output[2] == 0);
  assert(q.received == 5 && q.played == 5 && q.through == 5);
  AsidePcmCommand(&q, AsideHold);
  AsidePcmEnqueue(&q, input, 5);
  AsidePcmCommand(&q, AsideDiscard); AsidePcmCommand(&q, AsidePlay);
  AsidePcmRender(&q, output, 8);
  for (int i=0;i<8;i++) assert(output[i] == 0);
  for (int i=0;i<201;i++) AsidePcmEnqueue(&q, input, 5);
  assert(q.mode == AsideOverflow && q.overflows == 1);
  AsidePcmRender(&q, output, 8);
  for (int i=0;i<8;i++) assert(output[i] == 0);
  free(q.data); return 0;
}`,
    );
    execFileSync("cc", [
      "-std=c11",
      "-Wall",
      "-Werror",
      "-I",
      resolve("mobile/native"),
      source,
      "-o",
      binary,
    ]);
    execFileSync(binary);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
