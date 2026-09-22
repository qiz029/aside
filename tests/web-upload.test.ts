import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resumableUpload,
  readUpload,
  retryUpload,
  forgetUpload,
  type UploadStorage,
} from "../frontend/src/resumable-upload";
function fixture() {
  const values = new Map<string, string>();
  const storage: UploadStorage = {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => {
      values.set(k, v);
    },
    removeItem: (k) => {
      values.delete(k);
    },
  };
  const file = new File(["abcdefgh"], "sample.wav");
  const calls: string[] = [];
  const received: string[] = [];
  let failPart = 0,
    failComplete = false;
  const request = async <T>(path: string, init: RequestInit): Promise<T> => {
    calls.push(path);
    if (path === "/uploads") return { id: "upload-1", partSize: 4 } as T;
    if (path.endsWith("/complete")) {
      if (failComplete) throw Error("Completion response lost");
      assert.deepEqual(JSON.parse(init.body as string).parts, [
        { partNumber: 1, etag: "part-1" },
        { partNumber: 2, etag: "part-2" },
      ]);
      return { id: "episode-1" } as T;
    }
    const partNumber = Number(
      new URL(path, "http://local").searchParams.get("number"),
    );
    if (partNumber === failPart) throw Error("Interrupted");
    received.push(await (init.body as Blob).text());
    return { partNumber, etag: `part-${partNumber}` } as T;
  };
  return {
    file,
    storage,
    values,
    calls,
    received,
    request,
    failPart: (n: number) => {
      failPart = n;
    },
    failComplete: (v: boolean) => {
      failComplete = v;
    },
  };
}
test("web upload persists acknowledged parts and resumes after reload without allocating or resending them", async () => {
  const f = fixture();
  const options = {
    owner: "alice",
    title: "Sample",
    storage: f.storage,
    request: f.request,
  };
  f.failPart(2);
  await assert.rejects(resumableUpload(f.file, options), /Interrupted/);
  assert.equal(readUpload("alice", "upload-1", f.storage)?.parts.length, 1);
  f.calls.length = 0;
  f.failPart(0);
  assert.deepEqual(
    await resumableUpload(f.file, { ...options, resumeId: "upload-1" }),
    { id: "episode-1" },
  );
  assert.deepEqual(f.calls, [
    "/uploads/upload-1/part?number=2",
    "/uploads/upload-1/complete",
  ]);
  assert.deepEqual(f.received, ["abcd", "efgh"]);
  assert.equal(readUpload("alice", "upload-1", f.storage), null);
});
test("resume rejects different contents with identical filename and size and isolates accounts", async () => {
  const f = fixture();
  f.failPart(2);
  const options = {
    owner: "alice",
    title: "Sample",
    storage: f.storage,
    request: f.request,
  };
  await assert.rejects(resumableUpload(f.file, options));
  f.calls.length = 0;
  await assert.rejects(
    resumableUpload(new File(["abcdDIFF"], f.file.name), {
      ...options,
      resumeId: "upload-1",
    }),
    /同一个/,
  );
  await assert.rejects(
    resumableUpload(f.file, { ...options, owner: "bob", resumeId: "upload-1" }),
    /同一个/,
  );
  assert.deepEqual(f.calls, []);
});
test("lost completion can be repeated without uploading any parts", async () => {
  const f = fixture();
  f.failComplete(true);
  const options = {
    owner: "alice",
    title: "Sample",
    storage: f.storage,
    request: f.request,
  };
  await assert.rejects(resumableUpload(f.file, options), /lost/);
  f.calls.length = 0;
  f.failComplete(false);
  await resumableUpload(f.file, { ...options, resumeId: "upload-1" });
  assert.deepEqual(f.calls, ["/uploads/upload-1/complete"]);
});
test("leaving or cancelling preserves acknowledged parts until explicit server cancellation succeeds", async () => {
  const f = fixture(),
    abort = new AbortController();
  await assert.rejects(
    resumableUpload(f.file, {
      owner: "alice",
      title: "Sample",
      storage: f.storage,
      request: f.request,
      signal: abort.signal,
      onProgress: (bytes) => {
        if (bytes === 4) abort.abort();
      },
    }),
  );
  assert.equal(readUpload("alice", "upload-1", f.storage)?.parts.length, 1);
  assert.ok(!f.calls.some((path) => path.endsWith("/complete")));
  forgetUpload("alice", "upload-1", f.storage);
  assert.equal(readUpload("alice", "upload-1", f.storage), null);
});
test("transient requests retry with backoff, but authorization and validation failures do not", async () => {
  for (const error of [
    new TypeError("network"),
    Object.assign(Error(), { status: 503 }),
    Object.assign(Error(), { status: 429 }),
  ]) {
    let attempts = 0;
    const waits: number[] = [];
    const result = await retryUpload(
      async () => {
        if (++attempts < 3) throw error;
        return "ok";
      },
      undefined,
      async (ms) => {
        waits.push(ms);
      },
    );
    assert.equal(result, "ok");
    assert.deepEqual(waits, [750, 1500]);
  }
  for (const status of [400, 401, 403, 404, 409, 413]) {
    let attempts = 0;
    await assert.rejects(
      retryUpload(async () => {
        attempts++;
        throw Object.assign(Error(), { status });
      }),
    );
    assert.equal(attempts, 1);
  }
});
test("retry is bounded and abort interrupts backoff", async () => {
  let attempts = 0;
  await assert.rejects(
    retryUpload(
      async () => {
        attempts++;
        throw new TypeError("offline");
      },
      undefined,
      async () => {},
    ),
  );
  assert.equal(attempts, 3);
  const abort = new AbortController();
  const retry = retryUpload(async () => {
    abort.abort();
    throw new TypeError("offline");
  }, abort.signal);
  await assert.rejects(retry, { name: "AbortError" });
});
test("storage failure is detected before allocating an upload", async () => {
  const f = fixture();
  await assert.rejects(
    resumableUpload(f.file, {
      owner: "alice",
      title: "Sample",
      request: f.request,
      storage: {
        ...f.storage,
        setItem() {
          throw Error("Quota exceeded");
        },
      },
    }),
    /网站存储/,
  );
  assert.deepEqual(f.calls, []);
});
