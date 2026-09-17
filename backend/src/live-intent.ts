import type {
  LiveControlEvent,
  LiveControlUpdate,
  LivePlayerState,
  PlayerInput,
  QuestionRequest,
  QuestionResult,
  Turn,
} from "@aside/engine/contracts";

interface Ports {
  answer(
    request: QuestionRequest,
    signal: AbortSignal,
  ): Promise<QuestionResult>;
  emit(event: LiveControlEvent): void;
  context(text: string): void;
  now(): number;
  after(ms: number, callback: () => void): () => void;
}
/** Server-owned incremental interpretation. No browser transcript or keyword gate. */
export class LiveIntent {
  private text = "";
  private evaluated = "";
  private handled = "";
  private input?: PlayerInput;
  private history: Turn[];
  private endMs = -1;
  private lastInputAt = -1;
  private fragments = new Set<string>();
  private pending?: AbortController;
  private timer?: () => void;
  private acknowledgementTimer?: () => void;
  private waiting?: Extract<LiveControlEvent, { type: "decision" }>;
  private closed = false;
  private calls = 0;
  private epoch = 0;
  constructor(
    private player: LivePlayerState,
    history: Turn[],
    private ports: Ports,
    private debug = false,
    private limit = 30,
  ) {
    this.history = history.slice(-20);
  }

  receive(event: Record<string, unknown>) {
    if (
      this.closed ||
      event.type !== "session.input_transcript.delta" ||
      typeof event.delta !== "string"
    )
      return;
    const { delta } = event;
    if (!delta) return;
    const start =
      typeof event.start_ms === "number" ? event.start_ms : undefined;
    const end = typeof event.end_ms === "number" ? event.end_ms : undefined;
    // Timestamped Live frames can be repeated on a transport; text alone is not
    // an identity ("wait wait" contains two legitimate identical fragments).
    if (start !== undefined && end !== undefined) {
      const key = `${start}:${end}:${delta}`;
      if (this.fragments.has(key)) return;
      this.fragments.add(key);
      if (this.fragments.size > 256)
        this.fragments.delete(this.fragments.values().next().value!);
    }
    const gap =
      start !== undefined && this.endMs >= 0
        ? start - this.endMs
        : this.ports.now() - this.lastInputAt;
    if (this.input && gap > 1200) this.resetTurn();
    if (end !== undefined) this.endMs = end;
    this.lastInputAt = this.ports.now();
    if (!this.input)
      this.input = {
        turnId: crypto.randomUUID(),
        source: "voice",
        positionMs: this.player.positionMs,
        wasPlaying: this.player.wasPlaying,
        audibleSource: this.player.audibleSource,
        config: this.player.config,
      };
    this.text = (this.text + delta).slice(-12000);
    this.ports.emit({
      type: "observing",
      version: this.player.version,
      ...(this.debug ? { text: this.text } : {}),
    });
    this.schedule();
  }
  update(player: LivePlayerState, ack?: LiveControlUpdate["acknowledgement"]) {
    if (
      this.closed ||
      player.sequence <= this.player.sequence ||
      player.version < this.player.version
    )
      return;
    if (player.version !== this.player.version) this.resetTurn();
    this.player = player;
    if (ack && ack.decisionId === this.waiting?.decisionId) {
      const decision = this.waiting;
      this.waiting = undefined;
      this.acknowledgementTimer?.();
      if (ack.applied) {
        this.handled = decision.text;
        this.history = [
          ...this.history,
          { role: "user" as const, text: decision.text },
          ...(decision.result.action === "answer"
            ? [{ role: "assistant" as const, text: decision.result.answer }]
            : []),
        ].slice(-20);
        this.ports.context(
          JSON.stringify({
            commandId: decision.decisionId,
            status: "applied",
            player,
            note: "The browser applied this decision. Do not repeat the action or give a spoken control acknowledgement.",
          }),
        );
        if (
          decision.result.action === "player_control" &&
          decision.result.followUpQuestion
        ) {
          this.text = decision.result.followUpQuestion;
          this.evaluated = this.handled = "";
          this.input = {
            ...decision.player,
            config: player.config,
            handledText: undefined,
          };
        }
      } else this.resetTurn();
      this.schedule();
    }
  }
  private resetTurn() {
    this.epoch++;
    this.pending?.abort();
    // Keep the occupied slot until its promise settles, even if a provider
    // ignores cancellation. There is never more than one model call in flight.
    this.timer?.();
    this.timer = undefined;
    this.acknowledgementTimer?.();
    this.acknowledgementTimer = undefined;
    this.waiting = undefined;
    this.text = this.evaluated = this.handled = "";
    this.input = undefined;
  }
  private schedule() {
    if (
      this.closed ||
      this.pending ||
      this.waiting ||
      this.timer ||
      !this.text.trim() ||
      this.text.trim() === this.evaluated.trim()
    )
      return;
    // A fixed batching window is not a trailing debounce: continuous speech
    // cannot indefinitely postpone the first classification.
    this.timer = this.ports.after(160, () => {
      this.timer = undefined;
      void this.classify();
    });
  }
  private fail(error: string) {
    if (this.closed) return;
    this.ports.emit({ type: "error", error });
    this.close();
  }
  private async classify() {
    if (this.closed || !this.input || this.pending || this.waiting) return;
    if (++this.calls > this.limit) {
      this.fail(
        "Voice session reached its intent limit. Please reconnect the microphone.",
      );
      return;
    }
    const text = this.text,
      epoch = this.epoch,
      version = this.player.version;
    const player = {
      ...this.input,
      config: this.player.config,
      ...(this.handled ? { handledText: this.handled } : {}),
    };
    const controller = (this.pending = new AbortController());
    this.evaluated = text;
    this.ports.emit({
      type: "classifying",
      version,
      ...(this.debug ? { text } : {}),
    });
    try {
      const result = await this.ports.answer(
        {
          atMs: player.positionMs,
          revision: this.player.revision,
          history: [...this.history, { role: "user", text }],
          player,
        },
        AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      );
      if (
        this.closed ||
        controller.signal.aborted ||
        epoch !== this.epoch ||
        text.trim() !== this.text.trim()
      )
        return;
      const decision: Extract<LiveControlEvent, { type: "decision" }> = {
        type: "decision",
        version,
        decisionId: crypto.randomUUID(),
        player,
        text,
        result,
      };
      if (result.action !== "ignore" && result.action !== "wait") {
        this.waiting = decision;
        this.acknowledgementTimer = this.ports.after(10000, () =>
          this.fail(
            "Playback acknowledgement timed out. Please reconnect the microphone.",
          ),
        );
      }
      this.ports.emit({
        ...decision,
        text:
          result.action === "ignore" || result.action === "wait" ? "" : text,
      });
    } catch {
      if (!controller.signal.aborted && !this.closed && epoch === this.epoch)
        this.fail(
          "Voice intent classification failed. Please reconnect the microphone.",
        );
    } finally {
      if (this.pending === controller) this.pending = undefined;
      this.schedule();
    }
  }
  close() {
    this.closed = true;
    this.resetTurn();
    this.history = [];
    this.fragments.clear();
  }
}
