import {
  liveControlEventSchema,
  type LiveControlEvent,
} from "@aside/engine/contracts";

/** Consume the entire session: one decision does not close the NDJSON reader. */
export async function readLiveControl(
  response: Response,
  receive: (event: LiveControlEvent) => void,
) {
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw Error(
      typeof data.error === "string"
        ? data.error
        : "Voice control connection failed",
    );
  }
  if (
    !response.body ||
    !response.headers.get("content-type")?.includes("application/x-ndjson")
  )
    throw Error("Voice control stream is unavailable");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    closed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 128000)
        throw Error("Voice control event is too large");
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      if (done && buffer.trim()) lines.push(buffer);
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = liveControlEventSchema.parse(JSON.parse(line));
        if (event.type === "error") throw Error(event.error);
        receive(event);
        if (event.type === "closed") closed = true;
      }
      if (done) {
        if (!closed)
          throw Error(
            "Voice control disconnected. Please reconnect the microphone.",
          );
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
