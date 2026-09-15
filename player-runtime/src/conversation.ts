import {
  explicitResume,
  type Episode,
  type PlaybackState,
  type Turn,
} from "@aside/engine/core";
import type { Source } from "@aside/engine/contracts";
import type { VoicePort } from "./ports";
import type { PlayerBackend } from "./ports";
import { FollowupTimer } from "./followup-timer";
import { QuestionProgress } from "./question-progress";
import {
  ResponseLatencyTracker,
  type ResponseLatency,
} from "./response-latency";
import type { RuntimeClock } from "./runtime-clock";

export type ConversationVoice = Pick<
  VoicePort,
  "append" | "activity" | "setWorking"
>;
interface ConversationHost {
  playback(): PlaybackState;
  episode(): Episode | undefined;
  voice(): ConversationVoice | undefined;
  resume(delayMs: number): void;
  textAnswered(): void;
  error(message: string): void;
  changed(): void;
  log(message: string): void;
}
/** Owns a question turn from input through cancellation, answer and follow-up. */
export class Conversation {
  private turns: Turn[] = [];
  private committed: Turn[] = [];
  completedHistory() {
    return this.committed;
  }
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
      history: this.turns,
      sources: this.references,
      question: this.draft,
      busy: !!this.pending,
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
  reset(history: Turn[] = []) {
    this.cancel();
    this.turns = history.slice(-100);
    this.committed = [...this.turns];
    this.references = [];
    this.draft = "";
    this.held = false;
    this.beganAt = null;
    this.streamIds = {};
    this.host.changed();
  }
  cancel() {
    this.turns = [...this.committed];
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
    this.cancel();
    if (firstInterruption) {
      this.held = false;
      this.beganAt = this.clock.now();
    }
    this.longAnswer = false;
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
    this.host.changed();
  }
  private noteAnswer(text: string) {
    this.longAnswer =
      text.length > 350 || (text.match(/[\u3400-\u9fff]/g)?.length ?? 0) > 180;
  }
  private addUser(text: string) {
    this.history([
      ...this.turns,
      { id: this.streamIds.user, role: "user", text },
    ]);
  }
  submitText(text: string) {
    this.addUser(text);
    this.setDraft("");
    void this.answer();
  }
  firstQuestion(text: string) {
    this.addUser(text);
    if (explicitResume(text)) this.host.resume(1500);
    else void this.answer(undefined, true);
  }
  speechEnded(connection: "cold" | "warm", coldCapture: boolean) {
    this.latency.questionEnded(connection);
    if (!coldCapture) this.scheduleQuestion(450);
  }
  transcript(role: Turn["role"], text: string) {
    if (role === "user" && text.trim()) this.followup.cancel();
    const id =
      this.streamIds[role] ?? (this.streamIds[role] = crypto.randomUUID());
    const turns = [...this.turns];
    const at = turns.findIndex((turn) => turn.id === id);
    if (at >= 0) turns[at] = { ...turns[at], text: turns[at].text + text };
    else turns.push({ id, role, text });
    this.history(turns);
    if (role === "assistant")
      this.noteAnswer(turns.find((turn) => turn.id === id)!.text);
    else {
      if (this.delegation) this.pending?.abort();
      this.scheduleQuestion(700);
    }
  }
  delegate(id: string) {
    this.delegation = id;
    this.followup.cancel();
    this.scheduleQuestion(350);
  }
  private scheduleQuestion(delayMs: number) {
    this.debounce?.();
    const epoch = this.epoch;
    this.debounce = this.clock.after(delayMs, () => {
      if (epoch !== this.epoch || this.host.playback().userSpeaking) return;
      const latest = this.turns
        .filter((turn) => turn.role === "user")
        .at(-1)?.text;
      if (latest && explicitResume(latest)) this.host.resume(1500);
      else if (this.delegation) void this.answer(this.delegation);
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
      this.committed = [...this.turns];
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
      if (!valid() || !(delegationId || speak)) return;
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
    this.host.changed();
    try {
      const state = this.host.playback();
      const result = await this.backend.question(
        episode.id,
        {
          atMs: state.interruption?.atMs ?? state.positionMs,
          revision,
          history: this.turns,
        },
        controller.signal,
        (phase) => progress.update(phase),
      );
      progress.close();
      if (!valid()) return;
      if (result.revision !== revision) throw Error("回答轮次不匹配，请重试");
      this.references = result.sources;
      this.noteAnswer(result.answer);
      this.host.log(`tools: ${result.tools.join(", ") || "context"}`);
      if (result.action === "resume") {
        this.host.resume(1500);
        return;
      }
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
        this.committed = [...this.turns];
        this.host.textAnswered();
      }
    } catch (error) {
      if (valid()) {
        this.hold();
        this.latency.cancel();
        this.delegation = undefined;
        this.host.textAnswered();
        this.host.error(
          `${error instanceof Error ? error.message : String(error)}。可以继续听节目，或重新尝试提问。`,
        );
        if (delegationId || speak)
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
