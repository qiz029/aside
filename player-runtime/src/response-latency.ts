export interface ResponseLatency {
  connection: "cold" | "warm";
  milliseconds: number;
}

/** Measures audible answers only; progress speech and cancelled turns are excluded. */
export class ResponseLatencyTracker {
  private pending?: {
    connection: ResponseLatency["connection"];
    endedAt: number;
  };
  constructor(private now = () => performance.now()) {}
  questionEnded(connection: ResponseLatency["connection"]) {
    this.pending = { connection, endedAt: this.now() };
  }
  cancel() {
    this.pending = undefined;
  }
  output(isAnswer: boolean): ResponseLatency | undefined {
    if (!isAnswer || !this.pending) return;
    const result = {
      connection: this.pending.connection,
      milliseconds: Math.max(0, Math.round(this.now() - this.pending.endedAt)),
    };
    this.cancel();
    return result;
  }
}
