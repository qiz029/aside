import { z } from "zod";
import { playerCommandsSchema } from "@aside/engine/contracts";
import type { QuestionTool } from "./question-model.js";
export const questionTools: QuestionTool[] = [
  {
    type: "function",
    name: "control_podcast",
    description:
      "Control ONLY podcast playback when the user clearly addresses the app. Return 1-4 commands in execution order. For a request combining playback control and a content question, include only that content question in followUpQuestion so the app can execute first and then answer. Never control AI speech with this tool. Use pause for pause/stop playback; use stop only for explicitly ending listening and turning off the microphone. Use repeat for missed audio, adjust_rate for relative speed, and set_volume for absolute volume (0-1). Do not claim execution succeeded. Never execute quoted, negated, hypothetical or third-party instructions. If the utterance is incomplete, use wait_for_input.",
    parameters: z.toJSONSchema(
      z
        .object({
          commands: playerCommandsSchema,
          followUpQuestion: z.string().trim().min(1).max(2000).optional(),
        })
        .strict(),
    ),
    strict: false,
  },
  {
    type: "function",
    name: "ignore_input",
    description:
      "Silently ignore speech addressed to another person, incidental speech, or podcast audio. Do not answer, pause, change volume, or request clarification from bystanders.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "wait_for_input",
    description:
      'Wait silently when the incremental utterance does not yet establish whether the app is addressed or what action is wanted. A listener saying "wait", "wait wait" or "hold on" to interrupt podcast playback is a complete pause request: use control_podcast with pause instead. Later transcript updates can clarify genuinely incomplete requests.',
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "resume_podcast",
    description:
      "Return to the paused podcast when the user's meaning in the ongoing conversation is to keep listening. After an interruption and completed answer, casual 'OK, go on' or 'you can continue' can be sufficient; the user need not say 'podcast'. A yes/OK confirming the assistant's spoken offer to resume also qualifies. Never resume merely on a bare acknowledgement with no relevant offer, silence, a request to continue explaining, negation, quotations or speech to another person. Clarify briefly if the conversation does not resolve the ambiguity.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "get_passage",
    description:
      "Read already-heard podcast passages near a timestamp in milliseconds.",
    parameters: {
      type: "object",
      properties: { atMs: { type: "number" } },
      required: ["atMs"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "search_podcast",
    description: "Search already-heard podcast passages by keywords.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    strict: true,
  },
  { type: "web_search" },
];

/** The first Live round decides whether to engage; it cannot do a lookup. */
export const liveDecisionTools: QuestionTool[] = [
  ...questionTools.filter(
    (tool) =>
      tool.type === "function" &&
      [
        "control_podcast",
        "resume_podcast",
        "ignore_input",
        "wait_for_input",
      ].includes(tool.name),
  ),
  {
    type: "function",
    name: "accept_question",
    strict: true,
    description:
      "Confirm that the listener clearly addressed the assistant and wants a spoken response, including a brief clarification for an addressed ambiguous question. This opens the conversation immediately; facts and the full answer will be prepared afterward. Do not use for bystanders, incomplete addressee intent or playback controls.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
];
export const liveAnswerTools = questionTools.filter(
  (tool) =>
    tool.type === "web_search" ||
    ["get_passage", "search_podcast"].includes(tool.name),
);
