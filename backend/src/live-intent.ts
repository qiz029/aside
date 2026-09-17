import type {
  LiveControlEvent,
  LiveControlUpdate,
  LivePlayerState,
  PlayerInput,
  QuestionRequest,
  QuestionResult,
  Turn,
} from "@aside/engine/contracts";
import { LiveConversation } from "./live-conversation.js";

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
  private separators = "";
  private evaluated = "";
  private evaluatedConversation = -1;
  private refreshed = "";
  private handled = "";
  private input?: PlayerInput;
  private conversation: LiveConversation;
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
  private decidedAt = 0;
  constructor(
    private player: LivePlayerState,
    history: Turn[],
    private ports: Ports,
    private debug = false,
    private limit = 30,
  ) {
    this.conversation = new LiveConversation(history);
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
    // Captions can deliver spaces or sentence punctuation after the words have
    // already been answered. Such fragments are not a new user utterance and
    // must not cancel its answer. Buffer separators only for subsequent words
    // in the same input (including split decimals such as "0", ".", "5").
    if (!/[\p{L}\p{N}]/u.test(delta)) {
      if (this.input) this.separators = (this.separators + delta).slice(-12000);
      return;
    }
    const gap =
      start !== undefined && this.endMs >= 0
        ? start - this.endMs
        : this.ports.now() - this.lastInputAt;
    const replied =
      this.handled &&
      this.text.trim() === this.handled.trim() &&
      this.player.assistant?.text.trim() &&
      this.player.assistant.state !== "queued";
    if (this.input && (gap > 1200 || replied)) this.resetTurn();
    if (end !== undefined) this.endMs = end;
    this.lastInputAt = this.ports.now();
    if (!this.input)
      // Absence of this line after the listener spoke means the supplier never
      // transcribed the utterance, so no classification could follow.
      console.log("Aside voice input heard", {
        characters: delta.length,
        gapMs: Math.round(gap),
        wasPlaying: this.player.wasPlaying,
      });
    if (!this.input)
      this.input = {
        turnId: crypto.randomUUID(),
        source: "voice",
        positionMs: this.player.positionMs,
        wasPlaying: this.player.wasPlaying,
        audibleSource: this.player.audibleSource,
        config: this.player.config,
      };
    this.text = (this.text + this.separators + delta).slice(-12000);
    this.separators = "";
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
    ) {
      if (ack)
        console.warn("Aside voice acknowledgement discarded with its update", {
          closed: this.closed,
          sequence: player.sequence,
          lastSequence: this.player.sequence,
          version: player.version,
          lastVersion: this.player.version,
        });
      return;
    }
    if (player.version !== this.player.version) this.resetTurn();
    this.player = player;
    this.conversation.observe(player);
    if (ack && ack.decisionId !== this.waiting?.decisionId)
      console.warn("Aside voice acknowledgement matched no pending decision", {
        applied: ack.applied,
        pending: !!this.waiting,
      });
    if (ack && ack.decisionId === this.waiting?.decisionId) {
      const decision = this.waiting;
      this.waiting = undefined;
      this.acknowledgementTimer?.();
      console.log("Aside voice decision acknowledged", {
        action: decision.result.action,
        applied: ack.applied,
        afterMs: this.ports.now() - this.decidedAt,
        // A refusal is normally staleness: compare what was decided on with now.
        decidedRevision: decision.result.revision,
        revision: player.revision,
        decidedVersion: decision.version,
        version: player.version,
      });
      this.conversation.accept(decision, ack.applied, player);
      if (ack.applied) {
        this.handled = decision.text;
        this.ports.context(
          JSON.stringify({
            commandId: decision.decisionId,
            status: "accepted",
            player,
            note: "The client accepted this decision. Playback state reports whether it is playing or still resuming. An answer is only queued for speech; do not assume its full text was heard. Do not repeat player actions or give spoken control acknowledgements.",
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
    // A short confirmation can arrive just before the last output snapshot.
    // Re-evaluate unhandled input with that context, never replay handled input.
    this.schedule();
  }
  private resetTurn() {
    // A decision the browser never answered is the trace of a broken round trip.
    if (this.waiting)
      console.warn("Aside voice decision dropped before acknowledgement", {
        action: this.waiting.result.action,
        afterMs: this.ports.now() - this.decidedAt,
        version: this.player.version,
      });
    this.epoch++;
    this.pending?.abort();
    // Keep the occupied slot until its promise settles, even if a provider
    // ignores cancellation. There is never more than one model call in flight.
    this.timer?.();
    this.timer = undefined;
    this.acknowledgementTimer?.();
    this.acknowledgementTimer = undefined;
    this.waiting = undefined;
    this.text = this.evaluated = this.handled = this.refreshed = "";
    this.separators = "";
    this.input = undefined;
  }
  private schedule() {
    if (
      this.closed ||
      this.pending ||
      this.waiting ||
      this.timer ||
      !this.text.trim() ||
      this.text.trim() === this.handled.trim() ||
      (this.text.trim() === this.evaluated.trim() &&
        (this.evaluatedConversation === this.conversation.revision ||
          this.refreshed.trim() === this.text.trim()))
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
    console.error("Aside voice control ended", { error, call: this.calls });
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
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(15000),
    ]);
    // Refresh an unchanged utterance once for late dialogue context. Continuous
    // assistant output must neither starve an interruption nor repeatedly bill
    // for the same bystander speech. New user words remain independently eligible.
    const refreshing = this.evaluated.trim() === text.trim();
    if (refreshing) this.refreshed = text;
    this.evaluated = text;
    const conversationRevision = (this.evaluatedConversation =
      this.conversation.revision);
    const request: QuestionRequest = {
      atMs: player.positionMs,
      revision: this.player.revision,
      history: this.conversation.history(text),
      player,
      conversation: this.conversation.context(this.player),
    };
    this.ports.emit({
      type: "classifying",
      version,
      ...(this.debug
        ? {
            text,
            conversation: {
              ...request.conversation!,
              history: request.history.slice(-6),
            },
          }
        : {}),
    });
    try {
      const result = await this.ports.answer(request, signal);
      if (
        this.closed ||
        controller.signal.aborted ||
        epoch !== this.epoch ||
        (!refreshing && conversationRevision !== this.conversation.revision) ||
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
      this.decidedAt = this.ports.now();
      // The listener's words stay out of the log; shape and timing are enough.
      console.log("Aside voice decision", {
        action: result.action,
        commands:
          result.action === "player_control"
            ? result.commands.map((command) => command.type)
            : undefined,
        characters: text.length,
        call: this.calls,
        version,
        revision: result.revision,
        wasPlaying: player.wasPlaying,
      });
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
    } catch (error) {
      if (controller.signal.aborted || this.closed || epoch !== this.epoch)
        return;
      const reason = error instanceof Error ? error.message : String(error);
      const timedOut = signal.aborted;
      // The cause stays in the server log; the listener only sees a safe message.
      console.error("Aside voice intent classification failed", {
        reason,
        timedOut,
        call: this.calls,
        version,
      });
      this.fail(
        reason === "Trial stopped"
          ? "Voice session ended. Please reconnect the microphone."
          : timedOut
            ? "Voice intent classification timed out. Please reconnect the microphone."
            : "Voice intent classification failed. Please reconnect the microphone.",
      );
    } finally {
      if (this.pending === controller) this.pending = undefined;
      this.schedule();
    }
  }
  close() {
    this.closed = true;
    this.resetTurn();
    this.conversation.clear();
    this.fragments.clear();
  }
}
