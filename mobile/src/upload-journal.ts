export interface UploadPart {
  partNumber: number;
  etag: string;
}
export interface UploadJournal {
  id: string;
  partSize: number;
  file: { uri: string; name: string; mimeType: string; size: number };
  parts: UploadPart[];
}
/** Persist each acknowledgement before advancing; retry reuses the same upload. */
export async function sendRemainingParts(
  journal: UploadJournal,
  send: (
    number: number,
    offset: number,
    length: number,
  ) => Promise<{ etag: string }>,
  persist: (journal: UploadJournal) => Promise<void>,
  progress: (fraction: number) => void,
) {
  progress(
    Math.min(1, (journal.parts.length * journal.partSize) / journal.file.size),
  );
  for (
    let n = journal.parts.length + 1;
    (n - 1) * journal.partSize < journal.file.size;
    n++
  ) {
    const offset = (n - 1) * journal.partSize;
    const length = Math.min(journal.partSize, journal.file.size - offset);
    const part = await send(n, offset, length);
    journal.parts.push({ partNumber: n, etag: part.etag });
    await persist(journal);
    progress((offset + length) / journal.file.size);
  }
}
