import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveConversation } from "../backend/src/live-conversation.js";
import { createPlayerConfig } from "@aside/engine/player";
import type {
  LiveControlEvent,
  LivePlayerState,
} from "@aside/engine/contracts";
const player: LivePlayerState = {
  version: 0,
  sequence: 1,
  revision: 1,
  positionMs: 31000,
  wasPlaying: false,
  audibleSource: "none",
  config: createPlayerConfig(),
  playback: { mode: "awaiting_followup", interrupted: true, resumeMs: 30000 },
};
const decision = (
  id: string,
  answer = true,
): Extract<LiveControlEvent, { type: "decision" }> => ({
  type: "decision",
  decisionId: id,
  version: 0,
  player: { ...player, turnId: id, source: "voice" },
  text: "What does that mean?",
  result: answer
    ? {
        action: "answer",
        revision: 1,
        answer: "A planned explanation that was never spoken.",
        sources: [],
        tools: [],
      }
    : {
        action: "player_control",
        revision: 1,
        answer: "",
        sources: [],
        tools: [],
        commandId: id,
        commands: [{ type: "play" }],
      },
});
test("a follow-up uses the delivered clarification, not the model's unspoken draft", () => {
  const conversation = new LiveConversation([]);
  conversation.accept(decision("a"), true, player);
  assert.deepEqual(conversation.history("OK"), [
    { role: "user", text: "What does that mean?" },
    { role: "user", text: "OK" },
  ]);
  const heard: LivePlayerState = {
    ...player,
    assistant: {
      decisionId: "a",
      text: "Shall I resume the podcast?",
      state: "finished",
    },
  };
  conversation.observe(heard);
  assert.deepEqual(conversation.history("Yes"), [
    { role: "user", text: "What does that mean?" },
    { role: "assistant", text: "Shall I resume the podcast?" },
    { role: "user", text: "Yes" },
  ]);
  assert.deepEqual(conversation.context(heard).assistant, {
    decisionId: "a",
    state: "finished",
  });
  assert.equal(
    conversation.context(heard).playback.playback?.interrupted,
    true,
  );
});
test("interrupted speech stays in its own chronological turn and snapshots do not duplicate it", () => {
  const conversation = new LiveConversation([
    { role: "assistant", text: "Earlier" },
  ]);
  conversation.accept(decision("a"), true, player);
  conversation.observe({
    ...player,
    assistant: { decisionId: "a", text: "It means", state: "speaking" },
  });
  conversation.accept({ ...decision("b"), text: "Wait, what?" }, true, player);
  for (let i = 0; i < 2; i++)
    conversation.observe({
      ...player,
      assistant: {
        decisionId: "a",
        text: "It means that",
        state: "interrupted",
      },
    });
  assert.deepEqual(
    conversation.history("Go on").map((t) => t.text),
    [
      "Earlier",
      "What does that mean?",
      "It means that",
      "Wait, what?",
      "Go on",
    ],
  );
  conversation.observe({
    ...player,
    assistant: {
      decisionId: "unknown",
      text: "Unsolicited muted speech",
      state: "finished",
    },
  });
  assert.equal(
    conversation.history("OK").some((t) => t.text.includes("muted")),
    false,
  );
});
test("tool acceptance and observed playback are shared without inventing success or speech", () => {
  const conversation = new LiveConversation([]);
  conversation.accept(decision("play", false), true, {
    ...player,
    playback: { mode: "resuming", interrupted: true },
  });
  const result = conversation.context(player).recentActions[0];
  assert.equal(result.accepted, true);
  assert.deepEqual(result.commands, [{ type: "play" }]);
  assert.equal(result.observed.playback?.mode, "resuming");
  conversation.accept(decision("rejected", false), false, player);
  assert.equal(conversation.context(player).recentActions[1].accepted, false);
  assert.equal(conversation.history("OK").length, 2);
  conversation.accept(
    {
      ...decision("resume"),
      result: {
        action: "resume",
        revision: 1,
        answer: "",
        sources: [],
        tools: [],
      },
    },
    true,
    player,
  );
  assert.deepEqual(
    conversation.context(player).recentActions.at(-1)?.commands,
    [{ type: "play" }],
  );
});
test("session memory is bounded, omits queued speech, and can be cleared", () => {
  const conversation = new LiveConversation([]);
  for (let i = 0; i < 40; i++)
    conversation.accept(decision(String(i), i % 2 === 0), true, player);
  conversation.observe({
    ...player,
    assistant: { decisionId: "38", text: "", state: "queued" },
  });
  assert.ok(conversation.history("Latest").length <= 21);
  assert.equal(conversation.context(player).recentActions.length, 4);
  conversation.clear();
  assert.deepEqual(conversation.history("New"), [
    { role: "user", text: "New" },
  ]);
  assert.deepEqual(conversation.context(player).recentActions, []);
});
