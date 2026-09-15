import {
  errorSchema,
  questionEventSchema,
  questionResultSchema,
  type QuestionPhase,
  type QuestionResult,
} from "@aside/engine/contracts";
/** Consume progressive question events, retaining JSON compatibility for older servers. */
export async function readQuestion(
  response: Response,
  progress: (phase: QuestionPhase) => void,
  expectedRevision?: number,
): Promise<QuestionResult> {
  if (!response.ok) throw Error(errorSchema.parse(await response.json()).error);
  const checkRevision = (revision: number) => {
    if (expectedRevision !== undefined && revision !== expectedRevision)
      throw Error("回答轮次不匹配，请重试");
  };
  if (!response.headers.get("content-type")?.includes("application/x-ndjson")) {
    const result = questionResultSchema.parse(await response.json());
    checkRevision(result.revision);
    return result;
  }
  if (!response.body) throw Error("回答连接已关闭");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      if (done && buffer.trim()) lines.push(buffer);
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = questionEventSchema.parse(JSON.parse(line));
        if (event.type === "progress") {
          checkRevision(event.revision);
          progress(event.phase);
        }
        if (event.type === "error") throw Error(event.error);
        if (event.type === "result") {
          checkRevision(event.result.revision);
          return event.result;
        }
      }
      if (done) throw Error("回答连接中断，请重试");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
