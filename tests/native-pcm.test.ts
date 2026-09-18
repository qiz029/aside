import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "aside-pcm-"));
  writeFileSync(
    join(dir, "trace.c"),
    `
#include <stdio.h>
#include "AsidePcmQueue.h"
int main() {
  AsidePcmQueue q; AsidePcmInit(&q, 1000, 1);
  int command, count; int16_t pcm[2000];
  while (scanf("%d %d", &command, &count) == 2) {
    if (command >= 0) AsidePcmCommand(&q, command);
    for (int i = 0, x; i < count; i++) { scanf("%d", &x); pcm[i] = x; }
    AsidePcmProcess(&q, pcm, count);
    printf("%d %d %d %llu %llu %u %u", q.mode, q.active, AsidePcmDrained(&q),
      (unsigned long long)q.received, (unsigned long long)q.through, q.size, q.overflows);
    for (int i = 0; i < count; i++) printf(" %d", pcm[i]);
    puts("");
  }
  free(q.data);
}`,
  );
  execFileSync(process.env.CC ?? "cc", [
    "-std=c11",
    "-Wall",
    "-Werror",
    "-I",
    resolve("mobile/native"),
    join(dir, "trace.c"),
    "-o",
    join(dir, "trace"),
  ]);
  writeFileSync(
    join(dir, "Trace.java"),
    `
package com.aside.audio;
import java.nio.*;
import java.util.*;
public class Trace {
  public static void main(String[] args) {
    AsidePcmQueue q = new AsidePcmQueue(1000, 1);
    Scanner in = new Scanner(System.in);
    while (in.hasNextInt()) {
      int command = in.nextInt(), count = in.nextInt();
      if (command >= 0) q.command(command);
      ByteBuffer pcm = ByteBuffer.allocate(count * 2).order(ByteOrder.nativeOrder());
      for (int i = 0; i < count; i++) pcm.putShort(i * 2, in.nextShort());
      q.process(pcm, count * 2);
      System.out.print(q.mode + " " + (q.active ? 1 : 0) + " " + (q.drained() ? 1 : 0) + " " + q.received + " " + q.through + " " + q.size + " " + q.overflows);
      for (int i = 0; i < count; i++) System.out.print(" " + pcm.getShort(i * 2));
      System.out.println();
    }
  }
}`,
  );
  execFileSync("javac", [
    "-d",
    dir,
    resolve("mobile/native/android/AsidePcmQueue.java"),
    join(dir, "Trace.java"),
  ]);
});
after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});
function run(steps: { command?: number; pcm: number[] }[]) {
  const input = steps
    .map(({ command = -1, pcm }) => `${command} ${pcm.length} ${pcm.join(" ")}`)
    .join("\n");
  const c = execFileSync(join(dir, "trace"), { input, encoding: "utf8" });
  const java = execFileSync("java", ["-cp", dir, "com.aside.audio.Trace"], {
    input,
    encoding: "utf8",
  });
  assert.equal(
    java,
    c,
    "iOS C and Android Java must render the same samples and completion evidence",
  );
  return c
    .trim()
    .split("\n")
    .map((line) => {
      const [
        mode,
        active,
        drained,
        received,
        through,
        size,
        overflows,
        ...pcm
      ] = line.split(" ").map(Number);
      return { mode, active, drained, received, through, size, overflows, pcm };
    });
}
test("both native queues preserve a buffered word's quiet prefix and play each sample exactly once", () => {
  const result = run([
    { command: 1, pcm: [0, 1, 2, 800, 1600, 3200] },
    { command: 2, pcm: [400, 300, 200, 100] },
    { pcm: [0, 0, 0, 0, 0, 0] },
  ]);
  assert.deepEqual(result[0].pcm, [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(
    [...result[1].pcm, ...result[2].pcm],
    [0, 1, 2, 800, 1600, 3200, 400, 300, 200, 100],
  );
});
test("pending speech prevents drained evidence across a long buffered thinking gap", () => {
  const result = run([
    {
      command: 1,
      pcm: Array(920)
        .fill(0)
        .map((_, i) => (i === 0 || i === 919 ? 1000 : 0)),
    },
    { command: 2, pcm: Array(10).fill(0) },
    ...Array.from({ length: 90 }, () => ({ pcm: Array(10).fill(0) })),
    { pcm: Array(10).fill(0) },
    ...Array.from({ length: 90 }, () => ({ pcm: Array(10).fill(0) })),
  ]);
  assert.equal(result[91].active, 0);
  assert.equal(result[91].drained, 0, "the next buffered word has not played");
  assert.equal(result[92].active, 1);
  assert.equal(result.at(-1)!.drained, 1);
});
test("ignored audio and interruption never leak into the next admitted reply", () => {
  const result = run([
    { command: 1, pcm: [1000, 2000] },
    { command: 0, pcm: [3000, 4000] },
    { command: 1, pcm: [5000, 6000] },
    { command: 2, pcm: [0, 0] },
  ]);
  assert.deepEqual(result[1].pcm, [0, 0]);
  assert.deepEqual(result[3].pcm, [5000, 6000]);
});
test("native buffers remain bounded, overflow stays silent until a new connection", () => {
  const result = run([
    { command: 1, pcm: Array(1001).fill(1000) },
    { command: 2, pcm: [1000, 2000] },
    { command: 0, pcm: [3000] },
  ]);
  for (const status of result) {
    assert.equal(status.mode, 3);
    assert.equal(status.overflows, 1);
    assert.ok(status.pcm.every((sample) => sample === 0));
  }
});
test("idle input retains only a short preroll and cannot exhaust the reply buffer", () => {
  const result = run([{ command: 1, pcm: Array(1900).fill(0) }]);
  assert.equal(result[0].mode, 1);
  assert.equal(result[0].size, 200);
});
