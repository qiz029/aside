import {
  backendAction,
  jevActConfidence,
  type JevShadow,
  type ShadowAction,
  type ShadowHandle,
} from "./jev-shadow.js";
import type { Analysis } from "@aside/engine/core";
import { getPassage, searchPodcast } from "@aside/engine/server";
import {
  playerCommandsSchema,
  type LiveControlEvent,
  type LiveControlUpdate,
  type LivePlayerState,
  type PlayerInput,
  type QuestionResult,
  type Source,
} from "@aside/engine/contracts";
import { z } from "zod";
import type { QuestionTelemetry } from "./question-service.js";
import { delegationInstructions } from "./dialogue-policy.js";
import { LiveResponseTrigger } from "./live-response-trigger.js";
import { SpokenAnswerVariants } from "./spoken-answer-variants.js";

interface Ports {
  /** Push to the browser's NDJSON control stream. */
  emit(event: LiveControlEvent): void;
  /** Send a client event to GPT-Live over the sideband. */
  send(event: Record<string, unknown>): void;
  now(): number;
  after(ms: number, callback: () => void): () => void;
  telemetry?(totals: QuestionTelemetry): void;
  /**
   * Optional fast classifier asked beside the backend. A confident "ignore",
   * "pause" or "resume" is applied before the backend decides; the backend's
   * decision still follows and stands over it.
   */
  shadow?: JevShadow;
}
interface Delegation {
  id: string;
  input: PlayerInput;
  /** Supplier session time of the utterance's first fragment, for caption ownership. */
  startMs?: number;
  text: string;
  answer: string;
  sources: Source[];
  engaged?: string;
  ignored: boolean;
  waitingForInput: boolean;
  hasTools: boolean;
  /** A pause already sent for this utterance, resolving with the client's report. */
  fastPause?: Promise<{ applied: boolean; player: LivePlayerState }>;
  /** A resume already sent for this utterance on the fast classifier's answer. */
  fastResume?: Promise<{ applied: boolean; player: LivePlayerState }>;
  /** The browser was already told to ignore this utterance. */
  fastIgnore?: boolean;
  /** The backend has made its first decision; nothing may act ahead of it any more. */
  decided?: boolean;
  shadow?: ShadowHandle;
}
/**
 * Immediate, safe pause words. GPT-Live delegates these too, but a listener
 * saying "wait" deserves the podcast stopping before a backend round trip.
 */
const fastPause =
  /^[\s,，。.!！?？]*(等一下|等等|等一等|先等一下|先停一下|停一下|暂停|暂停一下|wait|wait wait|hold on|hang on|pause|pause it)[\s,，。.!！?？]*$/iu;

/**
 * Server side of Responses delegation. GPT-Live normally hands speech to the
 * configured backend and speaks the result. Missing handoffs are requested over
 * the same sideband. This class executes backend tools and tells the browser
 * when to yield; the backend remains responsible for admission and intent.
 */
export class LiveDelegation {
  private text = "";
  private separators = "";
  private endMs = -1;
  private lastInputAt = -1;
  private fragments = new Set<string>();
  private input?: PlayerInput;
  private inputStartMs?: number;
  private delegation?: Delegation;
  private responseTrigger: LiveResponseTrigger;
  private inputEventId?: string;
  private retiredDelegations = new Set<string>();
  private waiting?: {
    decisionId: string;
    resolve(applied: boolean, player: LivePlayerState): void;
    cancel: () => void;
  };
  private closed = false;
  private calls = 0;
  private contextAt = -1;
  private contextSentAt = Number.NEGATIVE_INFINITY;
  private contextTimer?: () => void;
  private conversationKey = "";
  private answeredInput?: { turnId: string; text: string };
  private answerVariants?: SpokenAnswerVariants;
  constructor(
    private player: LivePlayerState,
    private analysis: Analysis,
    private ports: Ports,
    private debug = false,
    private limit = 30,
    private mobile = false,
  ) {
    this.contextAt = this.passageAt(player.positionMs);
    this.conversationKey = this.contextKey();
    this.responseTrigger = new LiveResponseTrigger({
      now: ports.now,
      after: ports.after,
      request: (eventId) => this.requestResponse(eventId),
      fail: (message) => this.fail(message),
    });
  }
  private passageAt(positionMs: number) {
    return (
      this.analysis.passages.find(
        (p) => p.startMs <= positionMs && p.endMs > positionMs,
      )?.startMs ?? -1
    );
  }
  receive(event: Record<string, unknown>) {
    if (this.closed) return;
    switch (event.type) {
      case "session.input_transcript.delta":
        this.transcript(event);
        return;
      case "session.output_transcript.delta":
        if (typeof event.delta === "string" && this.canObserveVariants())
          this.answerVariants?.observe(event.delta);
        return;
      case "session.delegation.created":
        this.created(event);
        return;
      case "response.event":
        this.backend(event);
        return;
      case "error":
        console.error("Aside voice supplier error", {
          error: JSON.stringify(event.error ?? event).slice(0, 400),
        });
        const eventId = (
          event.error as { client_event_id?: unknown } | undefined
        )?.client_event_id;
        if (this.inputEventId && eventId === this.inputEventId)
          this.fail(
            "Voice input could not be delivered. Please reconnect the microphone and try again.",
          );
        else this.responseTrigger.reject(eventId);
        return;
    }
  }
  private transcript(event: Record<string, unknown>) {
    if (typeof event.delta !== "string" || !event.delta) return;
    const { delta } = event;
    const start =
      typeof event.start_ms === "number" &&
      Number.isFinite(event.start_ms) &&
      event.start_ms >= 0
        ? event.start_ms
        : undefined;
    const end =
      typeof event.end_ms === "number" &&
      Number.isFinite(event.end_ms) &&
      event.end_ms >= (start ?? 0)
        ? event.end_ms
        : undefined;
    // Timestamped Live frames can be repeated on a transport; text alone is not
    // an identity ("wait wait" contains two legitimate identical fragments).
    if (start !== undefined && end !== undefined) {
      const key = `${start}:${end}:${delta}`;
      if (this.fragments.has(key)) return;
      this.fragments.add(key);
      if (this.fragments.size > 256)
        this.fragments.delete(this.fragments.values().next().value!);
    }
    if (!/[\p{L}\p{N}]/u.test(delta)) {
      if (this.input) this.separators = (this.separators + delta).slice(-12000);
      return;
    }
    const gap =
      start !== undefined && this.endMs >= 0
        ? start - this.endMs
        : this.ports.now() - this.lastInputAt;
    if (this.input && gap > 1200) this.resetUtterance();
    if (end !== undefined) this.endMs = end;
    this.lastInputAt = this.ports.now();
    if (!this.input) {
      console.log("Aside voice input heard", {
        characters: delta.length,
        gapMs: Math.round(gap),
        wasPlaying: this.player.wasPlaying,
      });
      this.inputStartMs = start;
      this.input = {
        turnId: crypto.randomUUID(),
        source: "voice",
        positionMs: this.player.positionMs,
        wasPlaying: this.player.wasPlaying,
        audibleSource: this.player.audibleSource,
        config: this.player.config,
      };
    }
    this.text = (this.text + this.separators + delta).slice(-12000);
    this.separators = "";
    if (this.delegation?.input.turnId === this.input.turnId)
      this.delegation.text = this.text;
    this.ports.emit({
      type: "observing",
      version: this.player.version,
      input: this.marker(),
      ...(this.debug ? { text: this.text } : {}),
    });
    this.pauseEarly();
    if (this.input) this.responseTrigger.observe(this.input.turnId);
  }
  /** Responses stays responsible for admission; a missed Live handoff cannot stall it. */
  private requestResponse(eventId: string) {
    if (++this.calls > this.limit) {
      this.fail(
        "Voice session reached its request limit. Please reconnect the microphone.",
      );
      return;
    }
    if (this.delegation?.input.turnId !== this.input!.turnId)
      this.replaceDelegation(this.startDelegation(`local:${eventId}`));
    this.delegation!.waitingForInput = false;
    this.delegation!.ignored = false;
    this.delegation!.answer = "";
    this.inputEventId = crypto.randomUUID();
    const { assistant, ...playback } = this.player;
    // Explicit requests must carry the observed words, not rely on Live having
    // already prepared a user turn. Microphone words remain untrusted user data.
    this.ports.send({
      type: "response.item.create",
      event_id: this.inputEventId,
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify({
              voiceInput: { turnId: this.input!.turnId, text: this.text },
              player: this.delegation!.input,
              conversation: { playback, assistant },
            }),
          },
        ],
      },
    });
    console.log("Aside voice delegation fallback requested", {
      characters: this.text.length,
      version: this.player.version,
      eventId,
      inputEventId: this.inputEventId,
    });
    this.ports.emit({
      type: "classifying",
      version: this.player.version,
      input: this.marker(),
      ...(this.debug ? { text: this.text } : {}),
    });
    this.ports.send({ type: "response.create", event_id: eventId });
  }
  private replaceDelegation(next: Delegation) {
    if (this.delegation && this.delegation.id !== next.id) {
      this.delegation.shadow?.close();
      this.retire(this.delegation.id);
    }
    this.delegation = next;
  }
  private retire(id: string) {
    this.retiredDelegations.add(id);
    if (this.retiredDelegations.size > 32)
      this.retiredDelegations.delete(
        this.retiredDelegations.values().next().value!,
      );
  }
  /** A bare pause word stops the podcast now; the backend's later pause call is then already done. */
  private pauseEarly() {
    if (
      !this.input?.wasPlaying ||
      this.waiting ||
      (this.delegation?.input.turnId === this.input.turnId &&
        this.delegation.fastPause) ||
      !fastPause.test(this.text)
    )
      return;
    const decisionId = crypto.randomUUID();
    if (this.delegation?.input.turnId !== this.input.turnId)
      this.replaceDelegation(this.startDelegation(`local:${decisionId}`));
    this.delegation!.fastPause = this.decide(decisionId, {
      revision: this.player.revision,
      action: "player_control",
      commandId: `${this.input.turnId}:fast-pause`,
      commands: [{ type: "pause" }],
      answer: "",
      sources: [],
      tools: ["control_podcast"],
    });
  }
  private resetUtterance() {
    this.text = this.separators = "";
    this.input = undefined;
    this.inputStartMs = undefined;
    this.answerVariants = undefined;
  }
  /** Which utterance an event belongs to, so the browser can attribute Live captions. */
  private marker(delegation?: Delegation) {
    const input = delegation?.input ?? this.input;
    return input
      ? {
          turnId: input.turnId,
          startMs: delegation?.startMs ?? this.inputStartMs,
        }
      : undefined;
  }
  private startDelegation(id: string): Delegation {
    this.input ??= {
      turnId: crypto.randomUUID(),
      source: "voice",
      positionMs: this.player.positionMs,
      wasPlaying: this.player.wasPlaying,
      audibleSource: this.player.audibleSource,
      config: this.player.config,
    };
    return {
      id,
      input: this.input,
      startMs: this.inputStartMs,
      text: this.text,
      answer: "",
      sources: [],
      ignored: false,
      waitingForInput: false,
      hasTools: false,
    };
  }
  private created(event: Record<string, unknown>) {
    const delegation = event.delegation as
      { id?: string; target?: string } | undefined;
    if (delegation?.target && delegation.target !== "responses") return;
    const id = delegation?.id ?? crypto.randomUUID();
    if (this.retiredDelegations.has(id)) return;
    if (this.mobile && this.alreadyAnswered()) {
      if (this.canObserveVariants()) this.answerVariants?.start(id);
      this.retire(id);
      return;
    }
    // A local pause already opened this utterance's delegation record.
    if (this.delegation?.id.startsWith("local:") && !this.delegation.engaged)
      this.delegation.id = id;
    else if (this.delegation?.id !== id)
      this.replaceDelegation(this.startDelegation(id));
    this.responseTrigger.started(this.delegation!.input.turnId);
    console.log("Aside voice delegation created", {
      characters: this.text.length,
      wasPlaying: this.delegation!.input.wasPlaying,
    });
    this.ports.emit({
      type: "classifying",
      version: this.player.version,
      input: this.marker(this.delegation),
      ...(this.debug ? { text: this.text } : {}),
    });
  }
  private backend(envelope: Record<string, unknown>) {
    const event = envelope.event as Record<string, unknown> | undefined;
    if (!event || typeof event.type !== "string") return;
    const id =
      typeof envelope.delegation_id === "string"
        ? envelope.delegation_id
        : undefined;
    // Usage still belongs in the ledger even after a player action invalidates
    // the response. Its text and tools must no longer affect the browser.
    if (event.type === "response.completed" || event.type === "response.done") {
      const response = event.response as Record<string, any> | undefined;
      if (response?.usage) this.record(response);
    }
    if (id && this.retiredDelegations.has(id) && !this.answerVariants?.has(id))
      return;
    if (this.mobile && this.alreadyAnswered()) {
      if (id) {
        if (this.canObserveVariants()) this.answerVariants?.receive(id, event);
        this.retire(id);
      }
      return;
    }
    if (id && this.retiredDelegations.has(id)) return;
    const starting = !this.delegation || (id && this.delegation.id !== id);
    const delegation =
      this.delegation ??
      (this.delegation = this.startDelegation(
        typeof envelope.delegation_id === "string"
          ? envelope.delegation_id
          : crypto.randomUUID(),
      ));
    if (id && delegation.id !== id) {
      this.retire(delegation.id);
      delegation.id = id;
    }
    if (starting) this.responseTrigger.started(delegation.input.turnId);
    switch (event.type) {
      case "response.created":
        this.responseTrigger.started(delegation.input.turnId);
        delegation.hasTools = false;
        // Every path that reaches the backend passes here, with the text it saw.
        if (delegation.text.trim() && !delegation.shadow) {
          const { text } = delegation;
          delegation.shadow = this.ports.shadow?.(
            {
              text,
              wasPlaying: delegation.input.wasPlaying,
              interrupted: this.player.playback?.interrupted ?? false,
            },
            (action, confidence) =>
              this.actEarly(delegation, text, action, confidence),
          );
        }
        return;
      case "response.output_item.done": {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
          delegation.decided = true;
          delegation.shadow?.decided(
            backendAction(
              String(item.name ?? ""),
              typeof item.arguments === "string" ? item.arguments : "{}",
            ),
          );
          delegation.hasTools = true;
          void this.call(
            delegation,
            String(item.call_id ?? ""),
            String(item.name ?? ""),
            typeof item.arguments === "string" ? item.arguments : "{}",
          );
        }
        return;
      }
      case "response.output_text.delta":
        if (typeof event.delta === "string") {
          delegation.decided = true;
          delegation.shadow?.decided("question");
          delegation.answer = (delegation.answer + event.delta).slice(0, 64000);
          if (!delegation.engaged && !delegation.ignored)
            this.engage(delegation, delegation.text);
        }
        return;
      case "response.completed":
      case "response.done": {
        if (delegation.answer.trim() && delegation.engaged) {
          const answer = delegation.answer;
          console.log("Aside voice delegated answer", {
            characters: delegation.answer.length,
            sources: delegation.sources.length,
          });
          this.ports.emit({
            type: "answered",
            decisionId: delegation.engaged,
            answer: delegation.answer,
            sources: delegation.sources,
            final: !delegation.hasTools,
          });
          delegation.answer = "";
          if (this.mobile && !delegation.hasTools) {
            this.answeredInput = {
              turnId: delegation.input.turnId,
              text: delegation.text,
            };
            this.answerVariants = new SpokenAnswerVariants(
              {
                type: "answered",
                decisionId: delegation.engaged,
                answer,
                sources: delegation.sources,
                final: true,
              },
              (event) => this.ports.emit(event),
            );
            this.retire(delegation.id);
          }
        } else if (!delegation.engaged && !delegation.ignored) {
          // A control-only turn: the voice's own acknowledgement, if any, must
          // not surface later at the front of the next real answer.
          this.ports.emit({ type: "discard", version: this.player.version });
        }
        if (!delegation.hasTools)
          this.responseTrigger.finished(
            delegation.input.turnId,
            delegation.waitingForInput || delegation.ignored,
          );
        delegation.hasTools = false;
        return;
      }
      case "response.failed":
      case "response.incomplete":
        console.error("Aside voice delegated response failed", {
          type: event.type,
          detail: JSON.stringify(event.response ?? event).slice(0, 400),
        });
        this.fail(
          "Voice response failed. Please reconnect the microphone and try again.",
        );
        return;
    }
  }
  /**
   * Apply the fast classifier's answer ahead of the backend. Only what the
   * backend can take back is allowed: a wrongly continued podcast is stopped
   * again by its engage, a wrong pause or resume by its own command. Playback
   * changes carry parameters the classifier does not give, and an answer can
   * only come from the backend.
   */
  private actEarly(
    delegation: Delegation,
    seen: string,
    action: ShadowAction,
    confidence: number,
  ) {
    if (
      this.closed ||
      this.delegation !== delegation ||
      delegation.decided ||
      // The listener kept talking: this answer is about half a sentence.
      delegation.text !== seen ||
      confidence < jevActConfidence
    )
      return false;
    if (action === "ignore") {
      delegation.fastIgnore = true;
      this.emitPassive(delegation, "ignore", "ignore_input");
    } else if (action === "pause") {
      if (!delegation.input.wasPlaying || delegation.fastPause || this.waiting)
        return false;
      delegation.fastPause = this.decide(crypto.randomUUID(), {
        revision: this.player.revision,
        action: "player_control",
        commandId: `${delegation.input.turnId}:fast-pause`,
        commands: [{ type: "pause" }],
        answer: "",
        sources: [],
        tools: ["control_podcast"],
      });
    } else if (action === "resume") {
      const stopped =
        this.player.playback?.interrupted ||
        (this.player.playback
          ? this.player.playback.mode !== "playing"
          : !this.player.wasPlaying);
      if (!stopped || this.waiting) return false;
      delegation.fastResume = this.decide(crypto.randomUUID(), {
        revision: this.player.revision,
        action: "resume",
        answer: "",
        sources: [],
        tools: ["resume_podcast"],
      });
    } else return false;
    console.log("Aside voice early decision", {
      action,
      confidence: Math.round(confidence * 100) / 100,
    });
    return true;
  }
  private emitPassive(
    delegation: Delegation,
    action: "ignore" | "wait",
    tool: string,
  ) {
    this.ports.emit({
      type: "decision",
      version: this.player.version,
      input: this.marker(delegation),
      decisionId: crypto.randomUUID(),
      player: delegation.input,
      text: "",
      result: {
        revision: this.player.revision,
        action,
        answer: "",
        sources: [],
        tools: [tool],
      },
    });
  }
  private record(response: Record<string, any>) {
    const usage = response.usage ?? {};
    this.ports.telemetry?.({
      model: typeof response.model === "string" ? response.model : undefined,
      rounds: 1,
      tiers:
        typeof response.service_tier === "string"
          ? [response.service_tier]
          : [],
      inputTokens: usage.input_tokens ?? 0,
      cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
    });
  }
  private alreadyAnswered() {
    return (
      this.answeredInput?.turnId === this.input?.turnId &&
      this.answeredInput?.text === this.text
    );
  }
  private canObserveVariants() {
    if (!this.mobile || !this.alreadyAnswered()) return false;
    const assistant = this.player.assistant;
    return (
      !assistant ||
      (assistant.decisionId === this.delegation?.engaged &&
        assistant.state !== "finished" &&
        assistant.state !== "interrupted")
    );
  }
  private engage(delegation: Delegation, text: string) {
    const decisionId = crypto.randomUUID();
    delegation.engaged = decisionId;
    console.log("Aside voice engage", {
      characters: text.length,
      wasPlaying: delegation.input.wasPlaying,
      version: this.player.version,
    });
    this.ports.emit({
      type: "engage",
      version: this.player.version,
      revision: this.player.revision,
      input: this.marker(delegation),
      decisionId,
      player: delegation.input,
      text,
    });
  }
  private async call(
    delegation: Delegation,
    callId: string,
    name: string,
    args: string,
  ) {
    if (++this.calls > this.limit) {
      this.fail(
        "Voice session reached its tool call limit. Please reconnect the microphone.",
      );
      return;
    }
    const version = this.player.version;
    const id = delegation.id;
    // Awaiting a player acknowledgement can outlive this utterance. Its tool
    // result still settles the pending call, but cannot open audio or ask the
    // backend to continue an answer the mobile listener has replaced.
    const isCurrent = () =>
      !this.mobile ||
      (!this.closed &&
        this.player.version === version &&
        this.delegation === delegation &&
        delegation.id === id &&
        !this.retiredDelegations.has(id) &&
        this.input?.turnId === delegation.input.turnId);
    let output: unknown;
    try {
      output = await this.execute(delegation, name, args, isCurrent);
    } catch (error) {
      output = {
        error: error instanceof Error ? error.message : "Tool failed",
      };
    }
    if (this.closed) return;
    console.log("Aside voice tool call", {
      name,
      call: this.calls,
      accepted: (output as { accepted?: boolean } | null)?.accepted,
    });
    // Per the delegation guide: no delegation_id or body on these two.
    this.ports.send({
      type: "response.item.create",
      event_id: crypto.randomUUID(),
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output),
      },
    });
    if (isCurrent())
      this.ports.send({ type: "response.create", event_id: crypto.randomUUID() });
  }
  private async execute(
    delegation: Delegation,
    name: string,
    args: string,
    isCurrent: () => boolean,
  ): Promise<unknown> {
    const parsed: unknown = JSON.parse(args || "{}");
    const atMs = delegation.input.positionMs;
    if (name === "get_passage") {
      const { atMs: at } = z
        .object({ atMs: z.number().finite().nonnegative() })
        .parse(parsed);
      const passages = getPassage(this.analysis, at, atMs);
      delegation.sources.push(
        ...passages.map((p) => ({ text: p.text, startMs: p.startMs })),
      );
      if (!delegation.engaged && !delegation.ignored)
        this.engage(delegation, delegation.text);
      return passages;
    }
    if (name === "search_podcast") {
      const { query } = z.object({ query: z.string().max(2000) }).parse(parsed);
      const passages = searchPodcast(this.analysis, query, atMs);
      delegation.sources.push(
        ...passages.map((p) => ({ text: p.text, startMs: p.startMs })),
      );
      if (!delegation.engaged && !delegation.ignored)
        this.engage(delegation, delegation.text);
      return passages;
    }
    if (name === "control_podcast") {
      const { commands, followUpQuestion } = z
        .object({
          commands: playerCommandsSchema,
          followUpQuestion: z.string().trim().min(1).max(2000).optional(),
        })
        .strict()
        .parse(parsed);
      const onlyPause = commands.length === 1 && commands[0].type === "pause";
      const onlyPlay = commands.length === 1 && commands[0].type === "play";
      let result: { applied: boolean; player: LivePlayerState } | undefined;
      if (onlyPause && delegation.fastPause) {
        // The listener's own pause word already stopped the podcast; report
        // that outcome instead of pausing twice.
        result = await delegation.fastPause;
      } else if (onlyPlay && !followUpQuestion && delegation.fastResume) {
        result = await delegation.fastResume;
      } else {
        const decisionId = crypto.randomUUID();
        result = await this.decide(decisionId, {
          revision: this.player.revision,
          action: "player_control",
          commandId: `${delegation.input.turnId}:${decisionId.slice(0, 8)}`,
          commands,
          ...(followUpQuestion ? { followUpQuestion } : {}),
          answer: "",
          sources: [],
          tools: ["control_podcast"],
        });
      }
      if (
        isCurrent() &&
        followUpQuestion &&
        !delegation.engaged &&
        !delegation.ignored
      )
        this.engage(delegation, followUpQuestion);
      return {
        accepted: result.applied,
        player: this.observed(result.player),
        note: result.applied
          ? "The client applied the commands. Playback state reports the observed result; playback is asynchronous."
          : "The client rejected these commands as stale or unavailable; do not claim they ran.",
      };
    }
    if (name === "resume_podcast") {
      z.object({}).strict().parse(parsed);
      // Already resumed on the fast classifier's answer: report that outcome.
      const result = await (delegation.fastResume ??
        this.decide(crypto.randomUUID(), {
          revision: this.player.revision,
          action: "resume",
          answer: "",
          sources: [],
          tools: ["resume_podcast"],
        }));
      return {
        accepted: result.applied,
        player: this.observed(result.player),
      };
    }
    if (name === "ignore_input" || name === "wait_for_input") {
      z.object({}).strict().parse(parsed);
      if (name === "ignore_input") delegation.ignored = true;
      delegation.waitingForInput = name === "wait_for_input";
      // The browser already has this utterance's "ignore".
      if (name === "wait_for_input" || !delegation.fastIgnore)
        this.emitPassive(
          delegation,
          name === "ignore_input" ? "ignore" : "wait",
          name,
        );
      return { accepted: true };
    }
    return { error: "Unknown tool" };
  }
  private observed(player: LivePlayerState) {
    return {
      playback:
        player.playback?.mode ?? (player.wasPlaying ? "playing" : "paused"),
      interrupted: player.playback?.interrupted ?? false,
      positionMs: player.positionMs,
      playbackRate: player.config.playbackRate,
      volume: player.config.volume,
      muted: player.config.muted,
    };
  }
  /** Push one player decision and wait for the browser's execution report. */
  private decide(
    decisionId: string,
    result: QuestionResult,
  ): Promise<{ applied: boolean; player: LivePlayerState }> {
    const input = this.delegation?.input ?? this.input!;
    const text = this.delegation?.text ?? this.text;
    this.ports.emit({
      type: "decision",
      version: this.player.version,
      input: this.marker(this.delegation),
      decisionId,
      player: input,
      text,
      result,
    });
    console.log("Aside voice decision", {
      action: result.action,
      commands:
        result.action === "player_control"
          ? result.commands.map((command) => command.type)
          : undefined,
      version: this.player.version,
      revision: result.revision,
    });
    return new Promise((resolve) => {
      // Two player actions never race: the backend's calls are sequential.
      this.waiting?.cancel();
      const started = this.ports.now();
      const timer = this.ports.after(10000, () => {
        console.warn("Aside voice decision unacknowledged", {
          action: result.action,
          afterMs: this.ports.now() - started,
        });
        if (this.waiting?.decisionId === decisionId) this.waiting = undefined;
        resolve({ applied: false, player: this.player });
      });
      this.waiting = {
        decisionId,
        resolve: (applied, player) => {
          timer();
          console.log("Aside voice decision acknowledged", {
            action: result.action,
            applied,
            afterMs: this.ports.now() - started,
          });
          resolve({ applied, player });
        },
        cancel: () => {
          timer();
          resolve({ applied: false, player: this.player });
        },
      };
    });
  }
  update(player: LivePlayerState, ack?: LiveControlUpdate["acknowledgement"]) {
    if (
      this.closed ||
      player.sequence <= this.player.sequence ||
      player.version < this.player.version
    ) {
      if (ack)
        console.warn("Aside voice acknowledgement discarded with its update", {
          sequence: player.sequence,
          lastSequence: this.player.sequence,
          version: player.version,
          lastVersion: this.player.version,
        });
      return;
    }
    if (player.version !== this.player.version) {
      // A manual action invalidates the utterance in flight, not the session.
      this.waiting?.cancel();
      this.waiting = undefined;
      this.resetUtterance();
      if (this.delegation) this.retire(this.delegation.id);
      this.delegation = undefined;
      this.inputEventId = undefined;
      this.responseTrigger.reset();
    }
    this.player = player;
    if (ack && ack.decisionId === this.waiting?.decisionId) {
      const { resolve } = this.waiting;
      this.waiting = undefined;
      resolve(ack.applied, player);
    }
    this.refreshContext();
  }
  /** Passage updates coalesce for 3 s; mobile conversation transitions reach the backend immediately. */
  private refreshContext() {
    const at = this.passageAt(this.player.positionMs);
    const key = this.contextKey();
    const conversationChanged = this.mobile && key !== this.conversationKey;
    if (at === this.contextAt && !conversationChanged) return;
    const due = this.contextSentAt + 3000 - this.ports.now();
    if (due > 0 && !conversationChanged) {
      this.contextTimer ??= this.ports.after(due, () => {
        this.contextTimer = undefined;
        this.refreshContext();
      });
      return;
    }
    this.contextAt = at;
    this.conversationKey = key;
    this.contextSentAt = this.ports.now();
    this.ports.send({
      type: "session.update",
      event_id: crypto.randomUUID(),
      session: {
        delegation: {
          type: "responses",
          responses: {
            instructions: delegationInstructions(
              this.analysis,
              this.player.positionMs,
              this.mobile ? this.player : undefined,
            ),
          },
        },
      },
    });
  }
  private contextKey() {
    if (!this.mobile) return "";
    // Position, sequence and streaming caption fragments must not create
    // repeated updates at the native player's status cadence.
    const { wasPlaying, audibleSource, playback, config, assistant } =
      this.player;
    return JSON.stringify({
      wasPlaying,
      audibleSource,
      playback,
      config,
      assistant: assistant && {
        decisionId: assistant.decisionId,
        state: assistant.state,
        ...(assistant.state === "finished" ? { text: assistant.text } : {}),
      },
    });
  }
  private fail(error: string) {
    if (this.closed) return;
    console.error("Aside voice control ended", { error, calls: this.calls });
    this.ports.emit({ type: "error", error });
    this.close();
  }
  close() {
    this.closed = true;
    this.delegation?.shadow?.close();
    this.responseTrigger.close();
    this.waiting?.cancel();
    this.waiting = undefined;
    this.contextTimer?.();
    this.contextTimer = undefined;
    this.delegation = undefined;
    this.inputEventId = undefined;
    this.resetUtterance();
    this.fragments.clear();
    this.retiredDelegations.clear();
  }
}
