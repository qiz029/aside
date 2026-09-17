import {
  type Episode,
  type PlaybackState,
  type Turn,
} from "@aside/engine/core";
import type {
  Source,
  PlayerInput,
  QuestionResult,
} from "@aside/engine/contracts";
import { withKeepListeningHint } from "./i18n";
import type { OnDemandVoice } from "./on-demand-voice";
import type { PlayerBackend } from "./player-api";
import { FollowupTimer } from "./followup-timer";
import { QuestionProgress } from "./question-progress";
import {
  ResponseLatencyTracker,
  type ResponseLatency,
} from "./response-latency";
import type { RuntimeClock } from "./runtime-clock";

// This only selects a backend classification candidate; it never executes a
// command. Reject longer sentences, quotations and negations at this fast path.
const shortPauseRequest = (text: string) =>
  /^(?:please[\s,]+)?(?:(?:wait|pause|stop|hold on|hang on)[\s,.!?…]*)+(?:please[.!?]*)?$/i.test(
    text.trim(),
  );

// This routes possible English playback requests to the backend, never executes
// them. Prefixes, mixed-language context, negations and quotations must all reach
// the model so it can determine the addressee and whether an action is wanted.
const playbackControlCandidate = (text: string) =>
  /\b(?:wait|pause|stop|hold\s+on|hang\s+on|play|resume|continue|slower?|faster?|speed|volume|mute|unmute|louder|quieter|rewind|forward|replay|repeat|missed|skip|seek)\b/i.test(text);

export type ConversationVoice = Pick<
  OnDemandVoice,
  "append" | "activity" | "setWorking"
>;
interface ConversationHost {
  playback(): PlaybackState;
  episode(): Episode | undefined;
  voice(): ConversationVoice | undefined;
  resume(delayMs: number): void;
  playerInput(): PlayerInput | undefined;
  engage(): void;
  followup(text: string, speak: boolean): void;
  control(
    result: Extract<QuestionResult, { action: "player_control" }>,
    handledText: string,
  ): void;
  textAnswered(): void;
  error(message: string): void;
  changed(): void;
  log(message: string): void;
}
/** Owns a question turn from input through cancellation, answer and follow-up. */
export class Conversation {
  private turns: Turn[] = [];
  private provisionalTurns = new Set<string>();
  private references: Source[] = [];
  private draft = "";
  private held = false;
  private deadline: number | null = null;
  private waitMs = 3000;
  private beganAt: number | null = null;
  private epoch = 0;
  private pending?: AbortController;
  private debounce?: () => void;
  private delegation?: string;
  private settled = false;
  private acceptedInput = true;
  private submittedText = "";
  private seenDelegations = new Set<string>();
  private streamIds: Partial<Record<Turn["role"], string>> = {};
  private longAnswer = false;
  private answerQueued = false;
  private outputIsAnswer = false;
  private samples: ResponseLatency[] = [];
  private latency: ResponseLatencyTracker;
  private followup: FollowupTimer;
  constructor(
    private host: ConversationHost,
    private backend: PlayerBackend,
    private clock: RuntimeClock,
  ) {
    this.latency = new ResponseLatencyTracker(() => clock.now());
    this.followup = new FollowupTimer((deadline) => {
      this.deadline = deadline;
      host.changed();
    }, clock);
  }
  get snapshot() {
    return {
      history: this.turns.filter(
        (turn) => !turn.id || !this.provisionalTurns.has(turn.id),
      ),
      sources: this.references,
      question: this.draft,
      busy: !!this.pending && this.acceptedInput,
      resumeHeld: this.held,
      followupMs: this.waitMs,
      resumeSeconds:
        this.deadline === null
          ? null
          : Math.max(0, Math.ceil((this.deadline - this.clock.now()) / 1000)),
      latencies: this.samples,
    };
  }
  get startedAt() {
    return this.beganAt;
  }
  get pendingPause() {
    return (
      !!this.pending &&
      !this.pending.signal.aborted &&
      shortPauseRequest(this.submittedText)
    );
  }
  /** Read only: observing this must never submit or accept an utterance. */
  inputDiagnostics() {
    const input = this.turns.find((turn) => turn.id === this.streamIds.user);
    return {
      conversationInput: input?.text ?? "",
      submittedText: this.submittedText,
      requestPending: !!this.pending && !this.pending.signal.aborted,
      delegationReceived: !!this.delegation,
      shortPauseCandidate: shortPauseRequest(input?.text ?? ""),
      playbackControlCandidate: playbackControlCandidate(input?.text ?? ""),
      settled: this.settled,
      acceptedInput: this.acceptedInput,
    };
  }
  reset(history: Turn[] = []) {
    this.cancel();
    this.turns = history.slice(-100);
    this.provisionalTurns.clear();
    this.references = [];
    this.draft = "";
    this.held = false;
    this.beganAt = null;
    this.streamIds = {};
    this.acceptedInput = true;
    this.seenDelegations.clear();
    this.host.changed();
  }
  cancel() {
    this.epoch++;
    this.followup.cancel();
    this.debounce?.();
    this.debounce = undefined;
    this.pending?.abort();
    this.pending = undefined;
    this.delegation = undefined;
    this.answerQueued = false;
    this.outputIsAnswer = false;
    this.latency.cancel();
    this.host.voice()?.setWorking(false);
    this.host.changed();
  }
  beginTurn(firstInterruption: boolean) {
    this.acceptedInput = false;
    this.cancel();
    if (firstInterruption) {
      this.held = false;
      this.beganAt = this.clock.now();
    }
    this.longAnswer = false;
    this.settled = false;
    this.submittedText = "";
    this.streamIds = { user: crypto.randomUUID() };
  }
  continued() {
    this.cancel();
    this.held = false;
    this.beganAt = null;
    this.host.changed();
  }
  hold() {
    this.held = true;
    this.followup.cancel();
  }
  setDraft(text: string) {
    this.draft = text;
    this.followup.cancel();
  }
  setWait(delayMs: number) {
    this.waitMs = delayMs;
    this.scheduleFollowup();
    this.host.changed();
  }
  private history(turns: Turn[]) {
    this.turns = turns.slice(-100);
    const retained = new Set(this.turns.map((turn) => turn.id));
    for (const id of this.provisionalTurns)
      if (!retained.has(id)) this.provisionalTurns.delete(id);
    this.host.changed();
  }
  private noteAnswer(text: string) {
    this.longAnswer =
      text.length > 350 || (text.match(/[\u3400-\u9fff]/g)?.length ?? 0) > 180;
  }
  private addUser(text: string) {
    if (!this.acceptedInput && this.streamIds.user)
      this.provisionalTurns.add(this.streamIds.user);
    this.history([
      ...this.turns,
      { id: this.streamIds.user, role: "user", text },
    ]);
  }
  submitText(text: string) {
    this.acceptedInput = true;
    this.addUser(text);
    this.setDraft("");
    void this.answer();
  }
  firstQuestion(text: string) {
    this.addUser(text);
    void this.answer(undefined, true);
  }
  speechEnded(connection: "cold" | "warm", coldCapture: boolean) {
    this.latency.questionEnded(connection);
    if (!coldCapture) this.scheduleQuestion(450);
  }
  transcript(role: Turn["role"], text: string) {
    if (
      (role === "user" && this.settled && !this.acceptedInput) ||
      (role === "assistant" && !this.acceptedInput)
    )
      return;
    if (role === "user" && text.trim()) this.followup.cancel();
    const id =
      this.streamIds[role] ?? (this.streamIds[role] = crypto.randomUUID());
    if (role === "user" && !this.acceptedInput) this.provisionalTurns.add(id);
    const turns = [...this.turns];
    const at = turns.findIndex((turn) => turn.id === id);
    if (at >= 0) turns[at] = { ...turns[at], text: turns[at].text + text };
    else turns.push({ id, role, text });
    this.history(turns);
    // Keep space-only deltas so streamed words do not become "Heystop". They
    // do not invalidate an in-flight interpretation or start another request.
    if (role === "user" && !text.trim()) return;
    if (role === "assistant")
      this.noteAnswer(turns.find((turn) => turn.id === id)!.text);
    else {
      const latest = turns.find((turn) => turn.id === id)!.text;
      const repeatedPause =
        shortPauseRequest(this.submittedText) && shortPauseRequest(latest);
      if (this.pending && !repeatedPause) this.pending.abort();
      this.scheduleQuestion(120);
    }
  }
  delegate(id: string) {
    if (this.seenDelegations.has(id)) return;
    if (this.settled) {
      const latest = this.turns
        .filter((turn) => turn.role === "user")
        .at(-1)?.text;
      if (!this.acceptedInput || !latest || latest === this.submittedText)
        return;
      this.settled = false;
    }
    this.seenDelegations.add(id);
    if (this.seenDelegations.size > 100)
      this.seenDelegations.delete(this.seenDelegations.values().next().value!);
    this.delegation = id;
    this.followup.cancel();
    this.scheduleQuestion(0);
  }
  private scheduleQuestion(delayMs: number) {
    this.debounce?.();
    const epoch = this.epoch;
    this.debounce = this.clock.after(delayMs, () => {
      if (epoch !== this.epoch || this.settled) return;
      const latest = this.turns
        .filter((turn) => turn.role === "user")
        .at(-1)?.text;
      if (
        this.pending &&
        !this.pending.signal.aborted &&
        shortPauseRequest(this.submittedText) &&
        shortPauseRequest(latest ?? "")
      )
        return;
      // Live delegates as soon as it has an actionable clause. Do not wait for
      // local VAD speech-end; later transcript deltas cancel stale work.
      const controlCandidate =
        this.host.playerInput()?.source === "voice" &&
        playbackControlCandidate(latest ?? "");
      if (
        latest?.trim() &&
        latest !== this.submittedText &&
        (this.delegation || controlCandidate)
      ) {
        this.submittedText = latest;
        void this.answer(this.delegation, true);
      }
    });
  }
  outputStarted() {
    this.outputIsAnswer =
      this.answerQueued || (!this.pending && !this.delegation);
    const sample = this.latency.output(this.outputIsAnswer);
    if (sample) {
      this.samples = [...this.samples, sample].slice(-20);
      this.host.log(
        `首句有效回答 ${sample.connection === "cold" ? "首次连接" : "连续追问"}: ${sample.milliseconds}ms`,
      );
    }
    this.followup.cancel();
  }
  outputEnded() {
    if (this.outputIsAnswer) {
      this.answerQueued = false;
      this.scheduleFollowup();
    }
  }
  scheduleFollowup() {
    const epoch = this.epoch,
      revision = this.host.playback().revision;
    const delay =
      this.waitMs > 0 && this.longAnswer
        ? Math.max(this.waitMs, 8000)
        : this.waitMs;
    this.followup.arm(
      delay,
      () => {
        const state = this.host.playback();
        return (
          epoch === this.epoch &&
          revision === state.revision &&
          state.mode === "awaiting_followup" &&
          !!state.interruption &&
          !state.userSpeaking &&
          !state.assistantSpeaking &&
          !this.pending &&
          !this.delegation &&
          !this.answerQueued &&
          !this.draft.trim() &&
          !this.held
        );
      },
      () => this.host.resume(0),
    );
  }
  private async answer(delegationId?: string, speak = false) {
    this.followup.cancel();
    const episode = this.host.episode();
    if (!episode) return;
    this.pending?.abort();
    this.submittedText =
      this.turns.filter((turn) => turn.role === "user").at(-1)?.text ?? "";
    const handledText = this.submittedText;
    const controller = (this.pending = new AbortController());
    const epoch = this.epoch,
      revision = this.host.playback().revision;
    const valid = () =>
      !controller.signal.aborted &&
      this.pending === controller &&
      this.epoch === epoch &&
      this.host.episode()?.id === episode.id &&
      this.host.playback().revision === revision;
    const progress = new QuestionProgress((phase) => {
      // Unclassified speech must never provoke filler, pauses or audible replies.
      if (
        !valid() ||
        !(delegationId || speak) ||
        !this.host.playback().interruption
      )
        return;
      const latest =
        this.turns.filter((turn) => turn.role === "user").at(-1)?.text ?? "";
      this.host
        .voice()
        ?.append(
          "thinking",
          JSON.stringify({ latestActualUserUtterance: latest.slice(-400) }),
        );
      this.host
        .voice()
        ?.append(
          "commentary",
          phase === "searching"
            ? "Brief progress only: say you are looking that up, in the language of the latest actual user utterance. One short sentence; do not answer yet."
            : phase === "continuing"
              ? "Brief progress only: say you are checking a little more, in the language of the latest actual user utterance. One short sentence; do not answer yet."
              : "Brief progress only: say you need a moment to think, in the language of the latest actual user utterance. One short sentence; do not claim to be searching. Do not answer yet.",
          null,
        );
    }, this.clock);
    controller.signal.addEventListener("abort", () => progress.close(), {
      once: true,
    });
    this.host.voice()?.setWorking(true);
    this.host.log("Backend intent request started");
    this.host.changed();
    try {
      const state = this.host.playback();
      const result = await this.backend.question(
        episode.id,
        {
          atMs:
            this.host.playerInput()?.positionMs ??
            state.interruption?.atMs ??
            state.positionMs,
          revision,
          history: this.turns,
          player: this.host.playerInput(),
        },
        controller.signal,
        (phase) => progress.update(phase),
      );
      progress.close();
      if (!valid()) return;
      if (result.revision !== revision) throw Error("回答轮次不匹配，请重试");
      this.host.log(`Backend intent: ${result.action}`);
      if (result.action === "wait") {
        this.host
          .voice()
          ?.append(
            "thinking",
            "The app needs more of the utterance. Keep listening silently; no playback action was taken.",
            delegationId ?? null,
          );
        return;
      }
      this.settled = true;
      if (result.action === "ignore") {
        this.history(
          this.turns.filter((turn) => turn.id !== this.streamIds.user),
        );
        this.host
          .voice()
          ?.append(
            "instructions",
            "This speech was not addressed to the app. Remain silent. Do not acknowledge or ask a clarification. No playback action was taken.",
            delegationId ?? null,
          );
        this.delegation = undefined;
        return;
      }
      this.acceptedInput = true;
      if (this.streamIds.user)
        this.provisionalTurns.delete(this.streamIds.user);
      if (result.action === "player_control") {
        this.host.control(result, handledText);
        this.host.voice()?.append(
          "thinking",
          JSON.stringify({
            commandId: result.commandId,
            status: "dispatched",
            player: this.host.playerInput(),
            note: "The app dispatched these commands. Do not repeat them or announce playback success before actual playback. No spoken confirmation is needed.",
          }),
          delegationId ?? null,
        );
        this.delegation = undefined;
        if (result.followUpQuestion)
          this.host.followup(
            result.followUpQuestion,
            !!(delegationId || speak),
          );
        return;
      }
      this.references = result.sources;
      this.noteAnswer(result.answer);
      this.host.log(`tools: ${result.tools.join(", ") || "context"}`);
      if (result.action === "resume") {
        this.host.resume(1500);
        return;
      }
      this.host.engage();
      const voice = this.host.voice();
      if ((delegationId || speak) && voice) {
        this.answerQueued = true;
        voice.append("commentary", result.answer, delegationId ?? null);
        voice.activity();
        if (this.delegation === delegationId) this.delegation = undefined;
      } else {
        this.history([
          ...this.turns,
          { role: "assistant", text: result.answer },
        ]);
        this.host.textAnswered();
      }
    } catch (error) {
      if (valid()) {
        this.hold();
        this.latency.cancel();
        this.delegation = undefined;
        this.host.textAnswered();
        this.host.error(
          withKeepListeningHint(
            error instanceof Error ? error.message : String(error),
          ),
        );
        if ((delegationId || speak) && this.host.playback().interruption)
          this.host
            .voice()
            ?.append(
              "commentary",
              "资料查询失败。请说明暂时无法确认，不要编造答案。",
              delegationId ?? null,
            );
      }
    } finally {
      progress.close();
      if (this.pending === controller) {
        this.pending = undefined;
        this.host.voice()?.setWorking(false);
        if (!(delegationId || speak)) this.scheduleFollowup();
        this.host.changed();
      }
    }
  }
}
