/** Opt-in semantic evaluation: real model, synthetic dialogue, no microphone or player actions. */
import { QuestionService } from "../backend/src/question-service.js";
import { InteractiveProvider } from "../backend/src/interactive-provider.js";
import { createPlayerConfig } from "@aside/engine/player";
import type { Analysis } from "@aside/engine/core";
import type {
  QuestionRequest,
  QuestionResult,
  Turn,
} from "@aside/engine/contracts";

const key = process.env.OPENAI_API_KEY;
if (!key)
  throw Error("Set OPENAI_API_KEY to run this opt-in real-model evaluation.");
const service = new QuestionService(
  new InteractiveProvider(key, process.env.ASIDE_BACKEND_MODEL),
  3,
);
const analysis: Analysis = {
  version: "evaluation",
  source: "demo",
  voice: "feminine",
  voiceReason: "test",
  hostStyle: "A friendly, concise narrator.",
  summary: "",
  speakers: [],
  anchors: [],
  passages: [
    {
      id: "heard",
      startMs: 0,
      endMs: 10000,
      speaker: "host",
      text: "A biography tells someone else's life story. An autobiography tells your own.",
    },
  ],
};
const cases: {
  name: string;
  utterance: string;
  spoken: string;
  action: QuestionResult["action"];
  commands?: string[];
  playing?: boolean;
}[] = [
  {
    name: "return after explanation",
    spoken:
      "A biography describes another person's life; an autobiography describes your own.",
    utterance: "OK, you can continue now.",
    action: "resume",
  },
  {
    name: "yes confirms playback",
    spoken: "Shall I resume the podcast?",
    utterance: "Yes.",
    action: "resume",
  },
  {
    name: "yes confirms more explanation",
    spoken: "Would you like me to explain that distinction a little more?",
    utterance: "Yes.",
    action: "answer",
  },
  {
    name: "explicit elaboration",
    spoken: "Those are two kinds of biography.",
    utterance: "Continue explaining that point.",
    action: "answer",
  },
  {
    name: "bare acknowledgement",
    spoken: "A biography is a life story.",
    utterance: "OK.",
    action: "wait",
  },
  {
    name: "pause during playback",
    spoken: "",
    utterance: "Wait, wait!",
    action: "player_control",
    commands: ["pause"],
    playing: true,
  },
  {
    name: "combined rate and play",
    spoken: "That is the distinction.",
    utterance: "Play it a bit slower and keep going.",
    action: "player_control",
    commands: ["slower", "play"],
  },
  {
    name: "bystander conversation",
    spoken: "",
    utterance: "Honey, what should we have for dinner?",
    action: "ignore",
    playing: true,
  },
  {
    name: "Chinese continuation",
    spoken: "外传和内传是两种传记的名目。",
    utterance: "好吧，那你继续说吧。",
    action: "resume",
  },
];
let failures = 0;
for (const scenario of cases) {
  const history: Turn[] = scenario.spoken
    ? [
        { role: "user", text: "What does that mean?" },
        { role: "assistant", text: scenario.spoken },
      ]
    : [];
  const config = createPlayerConfig();
  const request: QuestionRequest = {
    atMs: 10000,
    revision: 1,
    history: [...history, { role: "user", text: scenario.utterance }],
    player: {
      turnId: scenario.name,
      source: "voice",
      positionMs: 10000,
      wasPlaying: !!scenario.playing,
      audibleSource: scenario.playing ? "podcast" : "none",
      config,
    },
    conversation: {
      playback: {
        positionMs: 10000,
        wasPlaying: !!scenario.playing,
        audibleSource: scenario.playing ? "podcast" : "none",
        config,
        playback: {
          mode: scenario.playing ? "playing" : "awaiting_followup",
          interrupted: !scenario.playing,
        },
      },
      ...(scenario.spoken
        ? { assistant: { decisionId: "previous", state: "finished" as const } }
        : {}),
      recentActions: [],
    },
  };
  const start = performance.now();
  const result = await service.answer(
    analysis,
    request,
    AbortSignal.timeout(30000),
  );
  const commands =
    result.action === "player_control"
      ? result.commands.map((c) => c.type)
      : [];
  // An equivalent play tool also fulfils a resume; acknowledgement may be silently ignored.
  const matches =
    result.action === scenario.action ||
    (scenario.action === "resume" && commands.includes("play")) ||
    (scenario.name === "bare acknowledgement" &&
      ["ignore", "wait", "answer"].includes(result.action));
  const passed =
    matches &&
    (!scenario.commands ||
      scenario.commands.every((c) =>
        c === "slower"
          ? result.action === "player_control" &&
            result.commands.some(
              (command) =>
                (command.type === "adjust_rate" &&
                  command.direction === "slower") ||
                (command.type === "set_rate" && command.rate < config.rate),
            )
          : commands.includes(c as (typeof commands)[number]),
      ));
  if (!passed) failures++;
  console.log(
    JSON.stringify({
      case: scenario.name,
      action: result.action,
      commands,
      milliseconds: Math.round(performance.now() - start),
      passed,
    }),
  );
}
if (failures) throw Error(`${failures} semantic evaluation cases failed`);
