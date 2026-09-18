import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ResponsesPreload,
  contextDelta,
  type ResponsesEvents,
} from "../backend/src/response-preload.js";
import { InteractiveProvider } from "../backend/src/interactive-provider.js";
import { QuestionService } from "../backend/src/question-service.js";
import type { QuestionModel } from "../backend/src/question-model.js";
import type { Analysis } from "@aside/engine/core";
import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { connectResponsesNode } from "../backend/src/responses-node.js";
import { connectResponsesWorker } from "../backend/src/responses-worker.js";

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const context = {
  playheadMs: 1000,
  currentPassage: null,
  recentTranscript: [],
  earlierExcerpts: [],
  hostStyle: "concise",
  history: [{ role: "assistant" as const, text: "Continue explaining?" }],
};
const request: Parameters<QuestionModel["reply"]>[0] = {
  context,
  instructions: "Decide",
  tools: [],
  toolResults: [],
  reasoningEffort: "low",
  toolChoice: "required",
};
function connection() {
  let events!: ResponsesEvents;
  let closed = 0;
  const sent: Record<string, any>[] = [];
  return {
    sent,
    get closed() {
      return closed;
    },
    connect: async (handlers: ResponsesEvents) => {
      events = handlers;
      return {
        send: (text: string) => sent.push(JSON.parse(text)),
        close: () => {
          closed++;
        },
      };
    },
    event: (event: unknown) => events.message(JSON.stringify(event)),
    lost: () => events.closed(),
    complete: (
      index: number,
      id = `response-${index}`,
      output: unknown[] = [],
    ) =>
      events.message(
        JSON.stringify({
          type: "response.completed",
          stream_id: sent[index].stream_id,
          response: { id, status: "completed", output },
        }),
      ),
  };
}

test("preload prepares server state without generating or waiting for speech", async () => {
  const c = connection();
  const warm = new ResponsesPreload(
    { model: "test", instructions: "Rules", tools: [], input: [] },
    c.connect,
  );
  await flush();
  assert.equal(c.sent.length, 1);
  assert.equal(c.sent[0].generate, false);
  assert.equal(c.sent[0].type, "response.create");
  assert.equal(
    await warm.reply({ model: "test", input: "too early" }),
    undefined,
    "cold input can fall back immediately",
  );
  c.complete(0, "prepared");
  await flush();
  const result = warm.reply({ model: "test", input: "new words" });
  assert.equal(c.sent[1].previous_response_id, "prepared");
  assert.notEqual(
    c.sent[1].stream_id,
    c.sent[0].stream_id,
    "the baseline stays cached in its own lane",
  );
  c.complete(1, "decision");
  assert.equal((await result)?.id, "decision");
  const next = warm.reply({ model: "test", input: "another turn" });
  assert.equal(
    c.sent[2].previous_response_id,
    "prepared",
    "discarded decisions never become conversation history",
  );
  c.complete(2);
  await next;
  warm.close();
  warm.close();
  assert.equal(c.closed, 1);
});

test("only changed context and new history are appended; edits replace the baseline history", () => {
  const current = {
    ...context,
    playheadMs: 2000,
    history: [...context.history, { role: "user" as const, text: "Yes" }],
  };
  assert.deepEqual(contextDelta(context, current), {
    contextUpdate: { playheadMs: 2000 },
    historyAppend: [{ role: "user", text: "Yes" }],
  });
  const edited = {
    ...context,
    history: [{ role: "user" as const, text: "Different conversation" }],
  };
  assert.deepEqual(contextDelta(context, edited), {
    contextUpdate: { history: edited.history },
    historyAppend: [],
  });
  assert.deepEqual(contextDelta(context, context), {
    contextUpdate: {},
    historyAppend: [],
  });
});

test("an aborted request cannot block a new decision or deliver its late result", async () => {
  const c = connection();
  const warm = new ResponsesPreload({ model: "test", input: [] }, c.connect);
  await flush();
  c.complete(0);
  await flush();
  const abort = new AbortController();
  const old = assert.rejects(
    warm.reply({ model: "test", input: "old" }, abort.signal),
    { name: "AbortError" },
  );
  abort.abort();
  await old;
  const next = warm.reply({ model: "test", input: "latest" });
  assert.notEqual(c.sent[1].stream_id, c.sent[2].stream_id);
  c.complete(1, "discarded");
  c.complete(2, "latest");
  assert.equal((await next)?.id, "latest");
  warm.close();
});

test("preload failure, timeout and connection loss leave HTTP fallback available", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const cause of [
    "connect",
    "timeout",
    "error",
    "close",
    "malformed",
  ] as const) {
    const c = connection();
    const warm = new ResponsesPreload(
      { model: "test", input: [] },
      cause === "connect"
        ? async () => {
            throw Error("offline");
          }
        : c.connect,
    );
    await flush();
    if (cause === "timeout") t.mock.timers.tick(5000);
    if (cause === "error")
      c.event({ type: "error", stream_id: c.sent[0].stream_id });
    if (cause === "close") c.lost();
    if (cause === "malformed")
      c.event({
        type: "response.completed",
        stream_id: c.sent[0].stream_id,
        response: {},
      });
    await flush();
    assert.equal(
      await warm.reply({ model: "test", input: "latest" }),
      undefined,
    );
    warm.close();
  }
});

test("provider uses prepared context for admission and HTTP for answers, with safe transport fallback", async (t) => {
  const c = connection();
  const provider = new InteractiveProvider(
    "placeholder",
    "test",
    false,
    c.connect,
  );
  const session = provider.prepareLive(request)!;
  t.after(() => session.close());
  const http: any[] = [];
  t.mock.method(provider.client.responses, "create", async (body: unknown) => {
    http.push(body);
    return {
      id: "http",
      status: "completed",
      output_text: "Answer",
      output: [],
    };
  });
  await flush();
  c.complete(0, "base");
  await flush();
  const live = {
    ...request,
    context: {
      ...context,
      history: [...context.history, { role: "user" as const, text: "Yes" }],
    },
  };
  const reply = session.model.reply(live);
  const sent = c.sent[1];
  assert.equal(sent.previous_response_id, "base");
  assert.deepEqual(JSON.parse(sent.input[0].content), {
    contextUpdate: {},
    historyAppend: [{ role: "user", text: "Yes" }],
  });
  c.complete(1, "accepted", [
    {
      type: "function_call",
      call_id: "call",
      name: "accept_question",
      arguments: "{}",
    },
  ]);
  assert.equal((await reply).calls[0].name, "accept_question");
  await session.model.reply({
    ...request,
    context: undefined,
    previousId: "accepted",
    toolChoice: undefined,
  });
  assert.equal(http[0].previous_response_id, "accepted");
  const fallback = session.model.reply(live);
  c.lost();
  assert.equal((await fallback).id, "http");
  assert.deepEqual(
    JSON.parse(http[1].input[0].content),
    live.context,
    "fallback sends the complete current snapshot, without a dead preload ID",
  );
});

test("question sessions start preload immediately and isolate listeners", async () => {
  const prepared: Parameters<QuestionModel["reply"]>[0][] = [];
  let closed = 0;
  const model: QuestionModel = {
    reply: async () => {
      throw Error("not expected");
    },
    prepareLive: (input) => {
      prepared.push(input);
      return {
        model,
        close: () => {
          closed++;
        },
      };
    },
  };
  const service = new QuestionService(model);
  const analysis: Analysis = {
    version: "1",
    source: "demo",
    summary: "",
    hostStyle: "host",
    speakers: [],
    voice: "feminine",
    voiceReason: "test",
    anchors: [],
    passages: [],
  };
  const first = service.prepareLive(analysis, 1000, [
    { role: "user", text: "first" },
  ])!;
  const second = service.prepareLive(analysis, 2000, [
    { role: "user", text: "second" },
  ])!;
  assert.equal(prepared.length, 2);
  assert.equal(prepared[0].context?.history[0].text, "first");
  assert.equal(prepared[1].context?.history[0].text, "second");
  assert.equal(prepared[0].toolChoice, "required");
  first.close();
  second.close();
  assert.equal(closed, 2);
  model.prepareLive = () => {
    throw Error("preparation unavailable");
  };
  assert.equal(service.prepareLive(analysis, 0, []), undefined);
  delete model.prepareLive;
  assert.equal(service.prepareLive(analysis, 0, []), undefined);
});

test("terminal failures fall back, unrelated events cannot resolve a request, and explicit continuations keep their parent", async () => {
  for (const terminal of ["error", "response.failed", "response.incomplete"]) {
    const c = connection();
    const warm = new ResponsesPreload({ model: "test", input: [] }, c.connect);
    await flush();
    c.complete(0);
    await flush();
    const next = warm.reply({
      model: "test",
      previous_response_id: "correction",
      input: [],
    });
    assert.equal(c.sent[1].previous_response_id, "correction");
    c.event({ type: "response.created", stream_id: c.sent[1].stream_id });
    c.event({
      type: "response.completed",
      stream_id: "unknown",
      response: { id: "unrelated", output: [] },
    });
    c.event({
      type: terminal,
      stream_id: c.sent[1].stream_id,
      error: { code: "previous_response_not_found" },
    });
    assert.equal(await next, undefined);
    warm.close();
  }
});

test("lane capacity, late opens, malformed transport and send failures never leave waiters hanging", async () => {
  const c = connection();
  const warm = new ResponsesPreload({ model: "test", input: [] }, c.connect);
  await flush();
  c.complete(0);
  await flush();
  const busy = [0, 1, 2].map(() => warm.reply({ model: "test", input: [] }));
  assert.equal(await warm.reply({ model: "test", input: [] }), undefined);
  warm.close();
  assert.deepEqual(await Promise.all(busy), [undefined, undefined, undefined]);
  const late = connection();
  const closed = new ResponsesPreload(
    { model: "test", input: [] },
    late.connect,
  );
  closed.close();
  await flush();
  assert.equal(late.closed, 1);
  assert.equal(late.sent.length, 0);
  const broken = new ResponsesPreload(
    { model: "test", input: [] },
    async () => ({
      send() {
        throw Error("closed socket");
      },
      close() {},
    }),
  );
  await flush();
  assert.equal(await broken.reply({ model: "test", input: [] }), undefined);
  broken.close();
  for (const message of [null, "not an event"]) {
    const c = connection();
    const warm = new ResponsesPreload({ model: "test", input: [] }, c.connect);
    await flush();
    c.event(message);
    await flush();
    assert.equal(await warm.reply({ model: "test", input: [] }), undefined);
    warm.close();
  }
});

test("Node connects authenticated Responses sockets and handles handshake failures", async () => {
  const received: string[] = [];
  const sent: string[] = [];
  let closed = 0;
  const socket = new EventEmitter() as WebSocket;
  socket.send = (value) => {
    sent.push(String(value));
  };
  socket.close = () => {
    closed++;
  };
  const connecting = connectResponsesNode(
    "test-key",
    {
      message: (s) => received.push(s),
      closed: () => {
        closed++;
      },
    },
    (url, options) => {
      assert.equal(url, "wss://api.openai.com/v1/responses");
      assert.equal(options.headers?.Authorization, "Bearer test-key");
      assert.equal(options.handshakeTimeout, 5000);
      return socket;
    },
  );
  socket.emit("open");
  const port = await connecting;
  socket.emit("message", Buffer.from("event"));
  port.send("request");
  port.close();
  socket.emit("close");
  assert.deepEqual(received, ["event"]);
  assert.deepEqual(sent, ["request"]);
  assert.equal(closed, 2);
  for (const event of ["close", "error"]) {
    const socket = new EventEmitter() as WebSocket;
    const connecting = connectResponsesNode(
      "test",
      { message() {}, closed() {} },
      () => socket,
    );
    socket.emit(event, Error("handshake failed"));
    await assert.rejects(connecting);
  }
});

test("Workers upgrade Responses sockets without keeping the handshake timeout on the open connection", async () => {
  const socket = new EventTarget() as EventTarget & {
    accept(): void;
    send(text: string): void;
    close(): void;
  };
  const sent: string[] = [],
    received: string[] = [];
  let accepted = 0,
    closed = 0;
  socket.accept = () => {
    accepted++;
  };
  socket.close = () => {
    closed++;
  };
  socket.send = (s) => {
    sent.push(s);
  };
  const events = {
    message: (s: string) => received.push(s),
    closed: () => {
      closed++;
    },
  };
  const port = await connectResponsesWorker(
    "test-key",
    events,
    async (url, headers) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      assert.deepEqual(headers, {
        Upgrade: "websocket",
        Authorization: "Bearer test-key",
      });
      return Object.assign(new Response(), { webSocket: socket });
    },
  );
  assert.equal(accepted, 1);
  socket.dispatchEvent(new MessageEvent("message", { data: "event" }));
  socket.dispatchEvent(
    new MessageEvent("message", { data: new ArrayBuffer(0) }),
  );
  port.send("request");
  port.close();
  socket.dispatchEvent(new Event("error"));
  assert.deepEqual(received, ["event"]);
  assert.deepEqual(sent, ["request"]);
  assert.equal(closed, 2);
  await assert.rejects(
    connectResponsesWorker(
      "test",
      events,
      async () => new Response(null, { status: 503 }),
    ),
    /unavailable/,
  );
});
