import { withKeepListeningHint } from "./recovery-message";
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
import type { VoicePort, PlayerBackend } from "./ports";
import { FollowupTimer } from "./followup-timer";
import { QuestionProgress } from "./question-progress";
import {
  ResponseLatencyTracker,
  type ResponseLatency,
} from "./response-latency";
import type { RuntimeClock } from "./runtime-clock";
import { SpokenCompletion } from "./spoken-completion";

export type ConversationVoice = Pick<
  VoicePort,
  "append" | "activity" | "setWorking"
>;
interface ConversationHost {
  playback(): PlaybackState;
  episode(): Episode | undefined;
  voice(): ConversationVoice | undefined;
  resume(delayMs: number): void;
  playerInput(): PlayerInput | undefined;
  /** Someone is audibly speaking right now, by local detection. */
  speaking(): boolean;
  engage(): void;
  /** Soft yield while a delegated utterance is classified; false once it is disregarded. */
  attend(active: boolean): void;
  followup(text: string, speak: boolean): void;
  control(
    result: Extract<QuestionResult, { action: "player_control" }>,
    handledText: string,
  ): void;
  textAnswered(): void;
  spokenFinished?(decisionId: string): void;
  error(message: string): void;
  changed(): void;
  log(message: string): void;
}
/**
 * Longest wait for the backend to decide on heard input before silence counts
 * again. The follow-up wait still runs after it, so a real question has both
 * (four seconds by default) to engage; measured engages take 1.2 to 2.7.
 */
export const pendingDecisionMs = 2000;
/** Owns a question turn from input through cancellation, answer and follow-up. */
export class Conversation {
  private turns: Turn[] = [];
  private committed: Turn[] = [];
  /** Submitted user messages and completed replies; an unanswered user tail is valid. */
  completedHistory() {
    return this.committed;
  }
  private provisionalTurns = new Set<string>();
  private references: Source[] = [];
  private draft = "";
  private answerPreview = "";
  private held = false;
  /** A barge-in's hold: it lasts until the listener's next accepted question. */
  private bargedIn = false;
  private deadline: number | null = null;
  private waitMs = 2000;
  private beganAt: number | null = null;
  private epoch = 0;
  private pending?: AbortController;
  private debounce?: () => void;
  private delegation?: string;
  private settled = false;
  private acceptedInput = true;
  private explicitInput = false;
  private submittedText = "";
  private seenDelegations = new Set<string>();
  private streamIds: Partial<Record<Turn["role"], string>> = {};
  private longAnswer = false;
  private answerQueued = false;
  private outputIsAnswer = false;
  private livePending = false;
  private pendingExpiry?: () => void;
  /** The delegated backend has engaged but not yet reported its finished answer. */
  private liveOpen = false;
  private liveAnswerId?: string;
  private spokenCompletion?: SpokenCompletion;
  private completionReported = false;
  private liveReplyOwner?: string;
  private samples: ResponseLatency[] = [];
  private latency: ResponseLatencyTracker;
  private followup: FollowupTimer;
  constructor(
    private host: ConversationHost,
    private backend: PlayerBackend,
    private clock: RuntimeClock,
    private spokenResume: "quiet" | "verified" = "quiet",
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
      answerPreview: this.answerPreview,
      busy: (!!this.pending && this.acceptedInput) || !!this.liveAnswerId,
      resumeHeld: this.held || this.bargedIn,
      resumeNeedsConfirmation:
        !!this.spokenCompletion && !this.spokenCompletion.complete,
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
  /** Only NDJSON-admitted replies use the timestamped Live caption reconciler. */
  get liveReplyId() {
    return this.liveReplyOwner;
  }
  /** Read only: observing this must never submit or accept an utterance. */
  inputDiagnostics() {
    const input = this.turns.find((turn) => turn.id === this.streamIds.user);
    return {
      conversationInput: input?.text ?? "",
      submittedText: this.submittedText,
      requestPending: !!this.pending && !this.pending.signal.aborted,
      delegationReceived: !!this.delegation,
      settled: this.settled,
      acceptedInput: this.acceptedInput,
    };
  }
  reset(history: Turn[] = []) {
    this.cancel();
    this.turns = history.slice(-100);
    this.committed = [...this.turns];
    this.provisionalTurns.clear();
    this.references = [];
    this.draft = "";
    this.held = false;
    this.bargedIn = false;
    this.beganAt = null;
    this.streamIds = {};
    this.acceptedInput = true;
    this.seenDelegations.clear();
    this.host.changed();
  }
  cancel(preserveProvisional = false) {
    this.answerPreview = "";
    // A second breath can extend unclassified input. Keep that context only
    // within the active interaction; explicit cancellation discards it.
    const provisional = preserveProvisional
      ? this.turns.filter(
          (turn) => turn.id && this.provisionalTurns.has(turn.id),
        )
      : [];
    this.turns = [...this.committed, ...provisional];
    if (!preserveProvisional) this.provisionalTurns.clear();
    this.epoch++;
    this.followup.cancel();
    this.debounce?.();
    this.debounce = undefined;
    this.pending?.abort();
    this.pending = undefined;
    this.delegation = undefined;
    this.answerQueued = false;
    this.outputIsAnswer = false;
    this.livePending = false;
    this.pendingExpiry?.();
    this.pendingExpiry = undefined;
    this.liveOpen = false;
    this.liveAnswerId = undefined;
    this.spokenCompletion = undefined;
    this.completionReported = false;
    this.liveReplyOwner = undefined;
    this.latency.cancel();
    this.host.voice()?.setWorking(false);
    this.host.changed();
  }
  beginTurn(firstInterruption: boolean) {
    this.acceptedInput = false;
    this.explicitInput = false;
    this.cancel(true);
    if (firstInterruption) {
      this.held = false;
      this.bargedIn = false;
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
    this.bargedIn = false;
    this.beganAt = null;
    this.host.changed();
  }
  hold() {
    this.held = true;
    this.followup.cancel();
  }
  /**
   * The listener talked over the reply. It is over, and silence after an
   * ignored barge-in must not resume; unlike a requested hold, their next
   * accepted question lifts it, so that answer can resume the podcast.
   */
  bargeIn() {
    this.bargedIn = true;
    this.liveOpen = false;
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
      (this.spokenResume === "verified" && this.longAnswer) ||
      text.length > 350 ||
      (text.match(/[\u3400-\u9fff]/g)?.length ?? 0) > 180;
  }
  private addUser(text: string) {
    if (!this.acceptedInput && this.streamIds.user)
      this.provisionalTurns.add(this.streamIds.user);
    this.history([
      ...this.turns,
      { id: this.streamIds.user, role: "user", text },
    ]);
  }
  /** A submitted message is complete even while its assistant reply is pending. */
  recognizeQuestion(text: string) {
    this.acceptedInput = true;
    this.explicitInput = true;
    const id = (this.streamIds.user ??= crypto.randomUUID());
    this.provisionalTurns.delete(id);
    // Native ASR publishes before Live is ready. The later ready callback
    // refers to this same message, so it must not append or save it twice.
    if (this.committed.some((turn) => turn.id === id && turn.text === text))
      return;
    const user: Turn = { id, role: "user", text };
    this.committed = [
      ...this.committed.filter((turn) => turn.id !== id),
      user,
    ].slice(-100);
    this.history([...this.turns.filter((turn) => turn.id !== id), user]);
  }
  submitText(text: string, speak = false) {
    this.recognizeQuestion(text);
    this.setDraft("");
    void this.answer(undefined, speak, this.spokenResume === "verified");
  }
  firstQuestion(text: string, explicit = false) {
    if (explicit) this.recognizeQuestion(text);
    else this.addUser(text);
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
    if (role === "assistant") {
      this.noteAnswer(turns.find((turn) => turn.id === id)!.text);
      this.spokenCompletion?.transcript(
        turns.find((turn) => turn.id === id)!.text,
      );
      this.confirmSpokenCompletion();
    } else {
      if (this.pending) this.pending.abort();
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
      if (latest?.trim() && latest !== this.submittedText && this.delegation) {
        this.submittedText = latest;
        void this.answer(this.delegation, true);
      }
    });
  }
  outputStarted() {
    this.spokenCompletion?.outputStarted();
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
  /** A played segment stopped; this is not a semantic Live reply boundary. */
  outputQuiet() {
    if (this.outputIsAnswer) {
      this.committed = this.snapshot.history;
      this.answerQueued =
        !!this.spokenCompletion && !this.spokenCompletion.complete;
      this.scheduleFollowup();
    }
  }
  outputDrained() {
    this.spokenCompletion?.outputDrained();
    this.confirmSpokenCompletion();
  }
  private confirmSpokenCompletion() {
    if (!this.spokenCompletion?.complete) return;
    if (!this.completionReported && this.liveReplyOwner) {
      this.completionReported = true;
      this.host.spokenFinished?.(this.liveReplyOwner);
    }
    this.answerQueued = false;
    this.scheduleFollowup();
    this.host.changed();
  }
  private expectSpokenAnswer(answer?: string) {
    this.spokenCompletion ??= new SpokenCompletion();
    if (answer !== undefined) this.spokenCompletion.answer(answer);
    this.confirmSpokenCompletion();
  }
  /** Why the follow-up window may not resume the podcast right now; empty when it may. */
  followupBlockers() {
    const state = this.host.playback();
    return [
      state.mode !== "awaiting_followup" && `mode ${state.mode}`,
      !state.interruption && "no interruption",
      this.waitMs <= 0 && "manual resume",
      state.userSpeaking && "listener speaking",
      this.host.speaking() && "speech detected",
      state.assistantSpeaking && "assistant speaking",
      this.pending && "question in flight",
      this.livePending && "input awaiting a decision",
      this.liveOpen && "backend still answering",
      this.liveAnswerId && "accepted answer pending",
      this.delegation && "delegation in flight",
      this.answerQueued && "answer not yet spoken",
      this.spokenCompletion &&
        !this.spokenCompletion.complete &&
        "native answer playback unconfirmed",
      this.draft.trim() && "draft in composer",
      this.held && "held by listener",
      this.bargedIn && "held after barge-in",
    ].filter((reason): reason is string => !!reason);
  }
  scheduleFollowup() {
    const epoch = this.epoch,
      revision = this.host.playback().revision;
    // A long written answer earns reading time; a spoken one has been heard.
    const delay =
      this.waitMs > 0 &&
      this.longAnswer &&
      (this.spokenResume === "verified" || !this.outputIsAnswer)
        ? Math.max(this.waitMs, 8000)
        : this.waitMs;
    const eligible = () =>
      epoch === this.epoch &&
      revision === this.host.playback().revision &&
      !this.followupBlockers().length;
    this.followup.arm(delay, eligible, () => this.host.resume(0));
    if (this.host.playback().mode === "awaiting_followup")
      this.host.log(
        eligible()
          ? `Auto-resume in ${delay}ms`
          : `Auto-resume waiting: ${this.followupBlockers().join(", ") || "stale turn"}`,
      );
  }
  /**
   * Heard input is waiting for the backend's decision. Detection alone can
   * raise this (a cough, an echo) and never produce a transcript to decide on,
   * so the wait expires once nobody is speaking: silence must not strand the
   * podcast behind a decision that will never come.
   */
  liveInputPending(value: boolean) {
    this.livePending = value;
    this.pendingExpiry?.();
    this.pendingExpiry = undefined;
    if (!value) return this.scheduleFollowup();
    this.followup.cancel();
    const expire = () => {
      if (this.host.speaking()) {
        this.pendingExpiry = this.clock.after(pendingDecisionMs, expire);
        return;
      }
      this.pendingExpiry = undefined;
      this.livePending = false;
      this.host.log("No decision for heard input; follow-up window reopened");
      this.scheduleFollowup();
    };
    this.pendingExpiry = this.clock.after(pendingDecisionMs, expire);
  }
  /**
   * The delegated backend is answering and the voice model speaks the result
   * itself. Opens the reply window without any client-side text to speak.
   */
  engageLive(text: string, decisionId: string) {
    this.beginTurn(!this.host.playback().interruption);
    this.liveReplyOwner = decisionId;
    this.streamIds = {
      user: `user:${decisionId}`,
      assistant: `assistant:${decisionId}`,
    };
    this.recognizeQuestion(text);
    this.submittedText = text;
    this.settled = true;
    this.references = [];
    this.host.log("Backend delegation engaged");
    this.host.engage();
    this.answerQueued = true;
    if (this.spokenResume === "verified") this.expectSpokenAnswer();
    this.bargedIn = false;
    // A quiet gap while the backend is still answering can be a lookup, not
    // the end of the reply: the follow-up window stays shut until `answered`.
    this.liveOpen = true;
    this.host.voice()?.activity();
    this.host.changed();
  }
  /**
   * The backend's answer: references and length only; the transcript carries
   * the words. A final answer is the reply boundary audio silence cannot give,
   * so from here a quiet follow-up window may resume the podcast.
   */
  liveAnswered(answer: string, sources: Source[], final = true) {
    this.references = sources;
    this.host.log(`Backend delegated answer (${answer.length} characters)`);
    if (final) {
      this.liveOpen = false;
      // Text finishes before speech does. If the voice is silent right now,
      // what it said so far was at most a progress sentence: the answer audio
      // is still to come and must play out before the window opens.
      if (!this.host.playback().assistantSpeaking) this.answerQueued = true;
      if (this.spokenResume === "verified") {
        this.noteAnswer(answer);
        this.expectSpokenAnswer(answer);
      }
      this.scheduleFollowup();
    }
    this.host.changed();
  }
  /** A server decision arrives on the session stream; this never submits a question. */
  receiveLive(
    result: QuestionResult,
    text: string,
    decisionId?: string,
    answerPending = false,
  ) {
    if (result.action === "ignore" || result.action === "wait") return;
    this.beginTurn(!this.host.playback().interruption);
    this.liveReplyOwner = decisionId;
    if (decisionId)
      this.streamIds = {
        user: `user:${decisionId}`,
        assistant: `assistant:${decisionId}`,
      };
    this.recognizeQuestion(text);
    this.submittedText = text;
    if (answerPending && result.action === "answer")
      this.liveAnswerId = decisionId;
    this.consumeResult(result, text, undefined, true, true);
    if (this.liveAnswerId) {
      this.host.voice()?.setWorking(true);
      this.host
        .voice()
        ?.append(
          "thinking",
          "The app accepted the listener's latest question and opened this spoken turn. You may acknowledge it briefly and naturally now. The backend is preparing the verified answer; wait for its result before giving factual details. Do not invent a lookup, repeat acknowledgements or resume podcast playback.",
          null,
        );
    }
    this.host.changed();
  }
  completeLive(
    decisionId: string,
    result: Extract<QuestionResult, { action: "answer" }>,
  ) {
    if (this.liveAnswerId !== decisionId) return;
    this.liveAnswerId = undefined;
    this.references = result.sources;
    this.noteAnswer(result.answer);
    if (this.spokenCompletion) this.expectSpokenAnswer(result.answer);
    this.host.voice()?.setWorking(false);
    if (result.answer.trim())
      this.host.voice()?.append("commentary", result.answer, null);
    this.host.voice()?.activity();
    this.host.changed();
  }
  /** Heard Live captions belong immediately after the question that owns them. */
  liveReply(decisionId: string, text: string, heard = true) {
    const userId = `user:${decisionId}`,
      id = `assistant:${decisionId}`;
    if (!this.turns.some((turn) => turn.id === userId)) return;
    const unchanged =
      (this.turns.find((turn) => turn.id === id)?.text ?? "") === text;
    if (
      unchanged &&
      (!heard ||
        (this.committed.find((turn) => turn.id === id)?.text ?? "") === text)
    )
      return;
    const turns = this.turns.filter((turn) => turn.id !== id);
    if (text)
      turns.splice(turns.findIndex((turn) => turn.id === userId) + 1, 0, {
        id,
        role: "assistant",
        text,
      });
    if (heard) {
      // Updating a late old caption must not commit a different, queued reply.
      this.committed = this.committed.filter((turn) => turn.id !== id);
      const user = this.committed.findIndex((turn) => turn.id === userId);
      if (text && user >= 0)
        this.committed.splice(user + 1, 0, { id, role: "assistant", text });
    }
    this.history(turns);
    if (id === this.streamIds.assistant) {
      this.noteAnswer(text);
      if (heard) {
        this.spokenCompletion?.transcript(text);
        this.confirmSpokenCompletion();
      }
    }
  }
  private consumeResult(
    result: QuestionResult,
    handledText: string,
    delegationId?: string,
    speak = false,
    serverOwned = false,
  ) {
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
      this.host.attend(false);
      if (!this.explicitInput)
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
    if (this.streamIds.user) this.provisionalTurns.delete(this.streamIds.user);
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
      if (result.followUpQuestion && !serverOwned)
        this.host.followup(result.followUpQuestion, !!(delegationId || speak));
      return;
    }
    this.references = result.sources;
    this.noteAnswer(result.answer);
    this.host.log(`tools: ${result.tools.join(", ") || "context"}`);
    if (result.action === "resume") {
      this.host.resume(serverOwned ? 0 : 1500);
      return;
    }
    this.host.engage();
    const voice = this.host.voice();
    if ((delegationId || speak) && voice) {
      this.answerQueued = true;
      // A server-pushed answer has no completion event, and GPT-Live may pause
      // to think before speaking again: silence cannot resume that one. An
      // answer this client fetched is complete, so its audio ending is the end.
      if (this.spokenResume === "verified") {
        this.bargedIn = false;
        this.expectSpokenAnswer(result.answer);
      } else if (serverOwned) this.hold();
      if (result.answer.trim())
        voice.append("commentary", result.answer, delegationId ?? null);
      voice.activity();
      if (this.delegation === delegationId) this.delegation = undefined;
    } else {
      this.history([...this.turns, { role: "assistant", text: result.answer }]);
      this.committed = this.snapshot.history;
      this.host.textAnswered();
    }
  }
  private async answer(
    delegationId?: string,
    speak = false,
    streamText = false,
  ) {
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
    if (delegationId) this.host.attend(true);
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
        !(delegationId || speak) || streamText
          ? (text) => {
              if (!valid()) return;
              this.answerPreview = text;
              this.host.changed();
            }
          : undefined,
      );
      progress.close();
      if (!valid()) return;
      if (result.revision !== revision) throw Error("回答轮次不匹配，请重试");
      this.host.log(`Backend intent: ${result.action}`);
      this.answerPreview = "";
      this.consumeResult(result, handledText, delegationId, speak);
    } catch (error) {
      if (valid()) {
        this.answerPreview = "";
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
