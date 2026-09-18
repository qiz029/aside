import type OpenAI from "openai";
import type { QuestionModel } from "./question-model.js";

type ResponseParameters = OpenAI.Responses.ResponseCreateParamsNonStreaming;
type Response = OpenAI.Responses.Response;
type Context = NonNullable<Parameters<QuestionModel["reply"]>[0]["context"]>;
export interface ResponsesEvents {
  message(text: string): void;
  closed(): void;
}
export interface ResponsesSocket {
  send(text: string): void;
  close(): void;
}
export type ConnectResponses = (
  events: ResponsesEvents,
) => Promise<ResponsesSocket>;

/** Each request forks the immutable baseline; speculative decisions aren't history. */
export function contextDelta(base: Context, current: Context) {
  const contextUpdate: Record<string, unknown> = {};
  for (const key of Object.keys(current) as (keyof Context)[])
    if (
      key !== "history" &&
      JSON.stringify(base[key]) !== JSON.stringify(current[key])
    )
      contextUpdate[key] = current[key];
  const extendsHistory = base.history.every(
    (turn, index) =>
      JSON.stringify(turn) === JSON.stringify(current.history[index]),
  );
  if (!extendsHistory) contextUpdate.history = current.history;
  return {
    contextUpdate,
    historyAppend: extendsHistory
      ? current.history.slice(base.history.length)
      : [],
  };
}

/** Optional latency optimization: a failed or unfinished preload never blocks HTTP. */
export class ResponsesPreload {
  private socket?: ResponsesSocket;
  private baseline?: string;
  private closed = false;
  private timer: ReturnType<typeof setTimeout>;
  private pending = new Map<
    string,
    {
      finish(response?: Response): void;
    }
  >();
  constructor(seed: ResponseParameters, connect: ConnectResponses) {
    const started = Date.now();
    this.timer = setTimeout(() => this.unavailable("timeout"), 5000);
    void connect({
      message: (text) => this.receive(text),
      closed: () => this.unavailable("connection_closed"),
    })
      .then(async (socket) => {
        if (this.closed) {
          socket.close();
          return;
        }
        this.socket = socket;
        const response = await this.send("context", {
          ...seed,
          generate: false,
        });
        if (this.closed || !response) return;
        this.baseline = response.id;
        clearTimeout(this.timer);
        console.log("Aside voice model preload", {
          state: "ready",
          afterMs: Date.now() - started,
        });
      })
      .catch(() => this.unavailable("connect"));
  }
  async reply(
    parameters: ResponseParameters,
    signal?: AbortSignal,
  ): Promise<Response | undefined> {
    signal?.throwIfAborted();
    if (this.closed || !this.baseline) return;
    // Aborted generations drain on their own lane. They cannot queue in front
    // of the next intent; both lane count and abandoned work stay bounded.
    const lane = ["intent-0", "intent-1", "intent-2"].find(
      (name) => !this.pending.has(name),
    );
    if (!lane) return;
    return this.send(
      lane,
      {
        ...parameters,
        previous_response_id: parameters.previous_response_id ?? this.baseline,
      },
      signal,
    );
  }
  private send(
    lane: string,
    parameters: ResponseParameters & { generate?: boolean },
    signal?: AbortSignal,
  ): Promise<Response | undefined> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (response?: Response) => {
        signal?.removeEventListener("abort", aborted);
        if (settled) return;
        settled = true;
        resolve(response);
      };
      const aborted = () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", aborted);
        reject(signal!.reason);
      };
      this.pending.set(lane, { finish });
      signal?.addEventListener("abort", aborted, { once: true });
      try {
        this.socket!.send(
          JSON.stringify({
            ...parameters,
            type: "response.create",
            stream_id: lane,
          }),
        );
      } catch {
        this.unavailable("send");
      }
    });
  }
  private receive(text: string) {
    if (this.closed) return;
    let event: {
      type?: string;
      stream_id?: string;
      response?: Response;
      error?: { code?: unknown };
    };
    try {
      event = JSON.parse(text);
    } catch {
      this.unavailable("invalid_event");
      return;
    }
    if (!event || typeof event !== "object") {
      this.unavailable("invalid_event");
      return;
    }
    if (event.type === "error") {
      this.unavailable("server_error", event.error?.code);
      return;
    }
    if (
      ![
        "response.completed",
        "response.failed",
        "response.incomplete",
      ].includes(event.type ?? "")
    )
      return;
    const lane = event.stream_id;
    const request = lane ? this.pending.get(lane) : undefined;
    if (!request) return;
    const response = event.response;
    if (
      event.type !== "response.completed" ||
      !response?.id ||
      !Array.isArray(response.output)
    ) {
      this.unavailable("failed_response", response?.error?.code);
      return;
    }
    this.pending.delete(lane!);
    request.finish(response);
  }
  private unavailable(reason: string, code?: unknown) {
    if (this.closed) return;
    console.warn("Aside voice model preload", {
      state: "unavailable",
      reason,
      ...(typeof code === "string" && /^[a-z_]{1,80}$/.test(code)
        ? { code }
        : {}),
    });
    this.close();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.baseline = undefined;
    this.socket?.close();
    for (const request of this.pending.values()) request.finish();
    this.pending.clear();
  }
}
