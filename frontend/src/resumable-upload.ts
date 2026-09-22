/** Only metadata and acknowledged parts are persisted; the audio stays on disk. */
export interface UploadJournal {
  id: string;
  partSize: number;
  title: string;
  name: string;
  size: number;
  fingerprint: string;
  parts: { partNumber: number; etag: string }[];
}
export interface UploadStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const key = (owner: string, id: string) =>
  `aside.upload.v1.${encodeURIComponent(owner)}.${id}`;
export function readUpload(
  owner: string,
  id: string,
  storage: UploadStorage = localStorage,
): UploadJournal | null {
  try {
    const value = JSON.parse(
      storage.getItem(key(owner, id)) ?? "null",
    ) as UploadJournal | null;
    if (
      !value ||
      value.id !== id ||
      !Number.isInteger(value.partSize) ||
      value.partSize <= 0 ||
      !Number.isInteger(value.size) ||
      value.size <= 0 ||
      typeof value.fingerprint !== "string" ||
      !Array.isArray(value.parts) ||
      value.parts.length > Math.ceil(value.size / value.partSize) ||
      !value.parts.every(
        (part, index) =>
          part.partNumber === index + 1 && typeof part.etag === "string",
      )
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
export function forgetUpload(
  owner: string,
  id: string,
  storage: UploadStorage = localStorage,
) {
  storage.removeItem(key(owner, id));
}
const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const done = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
export async function retryUpload<T>(
  run: () => Promise<T>,
  signal?: AbortSignal,
  wait = delay,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await run();
    } catch (error) {
      signal?.throwIfAborted();
      const status = (error as { status?: number })?.status;
      const transient =
        error instanceof TypeError ||
        status === 408 ||
        status === 429 ||
        (status !== undefined && status >= 500);
      if (!transient || attempt >= 2) throw error;
      await wait(750 * 2 ** attempt, signal);
    }
  }
}
/** Hash every byte in bounded chunks, so a similarly named file cannot corrupt a resume. */
export async function fileFingerprint(file: Blob, signal?: AbortSignal) {
  const hashes: string[] = [];
  for (let offset = 0; offset < file.size; offset += 8 * 1024 * 1024) {
    signal?.throwIfAborted();
    const hash = await crypto.subtle.digest(
      "SHA-256",
      await file.slice(offset, offset + 8 * 1024 * 1024).arrayBuffer(),
    );
    hashes.push(
      Array.from(new Uint8Array(hash), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join(""),
    );
  }
  signal?.throwIfAborted();
  return `${file.size}:${hashes.join(":")}`;
}
export async function resumableUpload<T>(
  file: File,
  options: {
    owner: string;
    title: string;
    resumeId?: string;
    signal?: AbortSignal;
    storage?: UploadStorage;
    request: <R>(path: string, init: RequestInit) => Promise<R>;
    onStarted?: (id: string) => void;
    onProgress?: (
      bytes: number,
      total: number,
      phase: "uploading" | "processing",
    ) => void;
  },
): Promise<T> {
  const { owner, signal, request } = options;
  const storage = options.storage ?? localStorage;
  const fingerprint = await fileFingerprint(file, signal);
  let journal = options.resumeId
    ? readUpload(owner, options.resumeId, storage)
    : null;
  if (options.resumeId && (!journal || journal.fingerprint !== fingerprint))
    throw Error("请选择上次上传的同一个音频文件");
  if (!journal) {
    // Check persistence before reserving a server upload.
    const probe = key(owner, "storage-check");
    try {
      storage.setItem(probe, "1");
      storage.removeItem(probe);
    } catch {
      throw Error("浏览器无法保存上传进度，请允许网站存储后重试");
    }
    signal?.throwIfAborted();
    // Keep the start response even if the caller leaves, so the reservation is recoverable.
    const upload = await request<{ id: string; partSize: number }>("/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: options.title, size: file.size }),
    });
    journal = {
      ...upload,
      title: options.title,
      name: file.name,
      size: file.size,
      fingerprint,
      parts: [],
    };
    storage.setItem(key(owner, journal.id), JSON.stringify(journal));
  }
  const upload = journal;
  options.onStarted?.(upload.id);
  options.onProgress?.(
    Math.min(upload.parts.length * upload.partSize, file.size),
    file.size,
    "uploading",
  );
  for (
    let offset = upload.parts.length * upload.partSize;
    offset < file.size;
    offset += upload.partSize
  ) {
    const partNumber = upload.parts.length + 1;
    const part = await retryUpload(
      () =>
        request<{ partNumber: number; etag: string }>(
          `/uploads/${upload.id}/part?number=${partNumber}`,
          {
            method: "PUT",
            body: file.slice(offset, offset + upload.partSize),
            signal,
          },
        ),
      signal,
    );
    upload.parts.push(part);
    storage.setItem(key(owner, upload.id), JSON.stringify(upload));
    options.onProgress?.(
      Math.min(offset + upload.partSize, file.size),
      file.size,
      "uploading",
    );
  }
  signal?.throwIfAborted();
  options.onProgress?.(file.size, file.size, "processing");
  // Completion is idempotent. Never abort a request that may already have started analysis.
  const result = await retryUpload(() =>
    request<T>(`/uploads/${upload.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: upload.parts }),
    }),
  );
  forgetUpload(owner, upload.id, storage);
  return result;
}
