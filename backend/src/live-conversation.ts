import type {
  ConversationContext,
  LiveControlEvent,
  LivePlayerState,
  SpokenReply,
  Turn,
} from "@aside/engine/contracts";
type Decision = Extract<LiveControlEvent, { type: "decision" }>;
const observed = (
  player: LivePlayerState,
): ConversationContext["playback"] => ({
  positionMs: player.positionMs,
  wasPlaying: player.wasPlaying,
  audibleSource: player.audibleSource,
  config: player.config,
  ...(player.playback ? { playback: player.playback } : {}),
});
/** One session history for conversation and player tools. Draft answers are not speech. */
export class LiveConversation {
  revision = 0;
  private turns: Turn[];
  private answers = new Map<string, string>();
  private assistant?: Omit<SpokenReply, "text">;
  private actions: ConversationContext["recentActions"] = [];
  constructor(history: Turn[]) {
    this.turns = history.slice(-20);
  }
  accept(decision: Decision, applied: boolean, player: LivePlayerState) {
    if (applied) {
      const userId = `user:${decision.decisionId}`;
      this.turns.push({ id: userId, role: "user", text: decision.text });
      if (decision.result.action === "answer")
        this.answers.set(decision.decisionId, userId);
      this.trim();
    }
    const commands =
      decision.result.action === "player_control"
        ? decision.result.commands
        : decision.result.action === "resume"
          ? [{ type: "play" as const }]
          : undefined;
    if (commands)
      this.actions = [
        ...this.actions,
        {
          decisionId: decision.decisionId,
          commands,
          accepted: applied,
          observed: observed(player),
        },
      ].slice(-4);
    this.observe(player);
  }
  observe(player: LivePlayerState) {
    const output = player.assistant;
    if (!output) return;
    const userId = this.answers.get(output.decisionId);
    if (!userId) return;
    const id = `assistant:${output.decisionId}`;
    const at = this.turns.findIndex((t) => t.id === id);
    if (
      this.assistant?.decisionId !== output.decisionId ||
      this.assistant?.state !== output.state ||
      (output.state !== "queued" &&
        this.turns[at]?.text !== output.text &&
        !!output.text.trim())
    )
      this.revision++;
    this.assistant = { decisionId: output.decisionId, state: output.state };
    if (output.state === "queued" || !output.text.trim()) return;
    const turn: Turn = { id, role: "assistant", text: output.text };
    if (at >= 0) this.turns[at] = turn;
    else
      this.turns.splice(
        this.turns.findIndex((t) => t.id === userId) + 1,
        0,
        turn,
      );
    this.trim();
  }
  history(input: string): Turn[] {
    return [
      ...this.turns.map(({ role, text }) => ({ role, text })),
      { role: "user", text: input },
    ];
  }
  context(player: LivePlayerState): ConversationContext {
    return {
      playback: observed(player),
      assistant: this.assistant,
      recentActions: [...this.actions],
    };
  }
  private trim() {
    this.turns = this.turns.slice(-20);
    for (const [id, userId] of this.answers)
      if (!this.turns.some((t) => t.id === userId)) this.answers.delete(id);
  }
  clear() {
    this.turns = [];
    this.actions = [];
    this.answers.clear();
    this.assistant = undefined;
    this.revision++;
  }
}
