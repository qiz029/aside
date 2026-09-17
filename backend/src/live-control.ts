import type { Analysis, Turn } from "@aside/engine/core";
import {
  liveControlEventSchema,
  type LiveControlEvent,
  type LiveControlUpdate,
  type LiveRequest,
} from "@aside/engine/contracts";
import { LiveIntent } from "./live-intent.js";
import type {
  QuestionAnswerer,
  QuestionTelemetry,
} from "./question-service.js";

/** One NDJSON subscription for one Live session, shared by both server adapters. */
export class LiveControl {
  private intent: LiveIntent;
  private sink?: ReadableStreamDefaultController<Uint8Array>;
  private connected = false;
  private closed = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private encoder = new TextEncoder();
  constructor(
    private sessionId: string,
    control: NonNullable<LiveRequest["control"]>,
    analysis: Analysis,
    history: Turn[],
    questions: QuestionAnswerer,
    context: (text: string) => void,
    telemetry?: (totals: QuestionTelemetry) => void,
    intentLimit = 30,
  ) {
    this.intent = new LiveIntent(
      control.player,
      history,
      {
        answer: (data, signal) =>
          questions.answer(analysis, data, signal, undefined, telemetry),
        emit: (event) => this.emit(event),
        context,
        now: Date.now,
        after: (ms, run) => {
          const timer = setTimeout(run, ms);
          return () => clearTimeout(timer);
        },
      },
      control.debug,
      intentLimit,
    );
  }
  private eventTypes = new Set<string>();
  receive(event: Record<string, unknown>) {
    // Event names only: which supplier signals accompany an utterance that
    // produced no transcript (speech detected, or nothing at all).
    const type = typeof event.type === "string" ? event.type : "unknown";
    // Audio frames arrive five times a second; once per session is enough.
    const repeating =
      type.endsWith(".delta") ||
      type.endsWith(".append") ||
      type.endsWith(".appended") ||
      type === "session.usage.updated";
    if (!repeating || !this.eventTypes.has(type))
      console.log("Aside voice sideband event", {
        type,
        subscribed: !!this.sink,
      });
    this.eventTypes.add(type);
    if (this.sink && !this.closed) this.intent.receive(event);
  }
  update(data: LiveControlUpdate) {
    if (this.closed || data.sessionId !== this.sessionId) {
      console.warn("Aside voice control update refused", {
        closed: this.closed,
        acknowledgement: !!data.acknowledgement,
      });
      return false;
    }
    this.intent.update(data.player, data.acknowledgement);
    return true;
  }
  subscribe(): Response {
    console.log("Aside voice control stream requested", {
      closed: this.closed,
      connected: this.connected,
    });
    if (this.closed || this.connected)
      return Response.json(
        {
          error:
            "Voice control session is unavailable. Reconnect the microphone.",
        },
        { status: 409 },
      );
    this.connected = true;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.sink = controller;
        this.emit({ type: "ready", sessionId: this.sessionId });
        this.heartbeat = setInterval(
          () => this.emit({ type: "heartbeat" }),
          15000,
        );
      },
      cancel: () => {
        console.warn("Aside voice control stream cancelled by the browser");
        this.sink = undefined;
        this.close();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-store",
      },
    });
  }
  private emit(event: LiveControlEvent) {
    if (!this.sink || this.closed) return;
    // A suspended tab must not accumulate an unbounded command queue.
    if ((this.sink.desiredSize ?? 0) < -64) {
      this.close();
      return;
    }
    this.sink.enqueue(
      this.encoder.encode(
        JSON.stringify(liveControlEventSchema.parse(event)) + "\n",
      ),
    );
    if (event.type === "error") this.close();
  }
  close(error?: string) {
    if (this.closed) return;
    if (error) this.emit({ type: "error", error });
    if (this.closed) return;
    this.closed = true;
    this.intent.close();
    clearInterval(this.heartbeat);
    this.sink?.enqueue(this.encoder.encode('{"type":"closed"}\n'));
    this.sink?.close();
    this.sink = undefined;
  }
}
