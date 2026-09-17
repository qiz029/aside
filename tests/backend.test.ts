import type { BackendServices } from "../backend/src/services.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../backend/src/store.js";
import { createApp } from "../backend/src/app.js";

const unused = async (): Promise<never> => {
  throw Error("Unexpected provider call in test");
};
test("local server attaches sideband before returning Live and streams server decisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "aside-live-control-"));
  const store = new Store(root);
  const { createPlayerConfig } = await import("@aside/engine/player");
  const analysis = {
    version: "1",
    source: "demo" as const,
    summary: "",
    hostStyle: "",
    passages: [],
    anchors: [],
    speakers: [],
    voice: "masculine" as const,
    voiceReason: "test",
  };
  store.put({
    id: "live-test",
    title: "test",
    createdAt: "now",
    durationMs: 10000,
    status: "ready",
    stage: "ready",
    progress: 1,
    analysis,
  });
  let receive!: (event: Record<string, unknown>) => void;
  let modelCalls = 0,
    attached = false;
  const app = createApp(
    store,
    fakeServices({
      voice: {
        transcribeQuestion: unused,
        createLive: async () => ({
          session: { id: "session" },
          transport: { sdp: "answer" },
        }),
        attachLive: async (_id, callback) => {
          receive = callback;
          attached = true;
          return { send() {}, close() {} };
        },
      },
      questions: {
        answer: async (_analysis, q, _signal, _progress, telemetry) => {
          modelCalls++;
          telemetry?.({
            rounds: 1,
            tiers: [],
            inputTokens: 1,
            cachedInputTokens: 0,
            outputTokens: 1,
            reasoningTokens: 0,
          });
          return {
            revision: q.revision,
            action: "ignore",
            answer: "",
            sources: [],
            tools: [],
          };
        },
      },
    }),
  );
  const player = {
    version: 0,
    sequence: 0,
    revision: 1,
    positionMs: 1000,
    wasPlaying: true,
    audibleSource: "podcast",
    config: createPlayerConfig(),
  };
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/episodes/live-test/live",
      payload: { sdp: "offer", atMs: 1000, control: { player } },
    });
    assert.equal(created.statusCode, 200);
    assert.equal(created.json().control, true);
    assert.equal(attached, true);
    assert.equal(
      (await app.inject("/api/episodes/other/live-control?sessionId=session"))
        .statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: "/api/episodes/live-test/live-control",
          payload: { sessionId: "session", player: { ...player, sequence: 1 } },
        })
      ).json().ok,
      true,
    );
    const reading = app.inject(
      "/api/episodes/live-test/live-control?sessionId=session",
    );
    // inject resolves only after the response stream ends. The simulated Live
    // emits independently while that single HTTP response remains open.
    const input = setTimeout(
      () =>
        receive({ type: "session.input_transcript.delta", delta: "Dinner?" }),
      30,
    );
    const end = setTimeout(() => receive({ type: "session.closed" }), 300);
    const stream = await reading;
    clearTimeout(input);
    clearTimeout(end);
    assert.match(stream.headers["content-type"]!, /ndjson/);
    const events = stream.body
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events[0].type, "ready");
    assert.equal(
      events.find((e) => e.type === "decision").result.action,
      "ignore",
    );
    assert.equal(events.at(-1).type, "closed");
    assert.equal(modelCalls, 1);
  } finally {
    await app.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
function fakeServices(overrides: Partial<BackendServices>): BackendServices {
  return {
    analysis: { transcribe: unused, enrich: unused },
    voice: { transcribeQuestion: unused, createLive: unused },
    questions: { answer: unused },
    ...overrides,
  };
}

test("persistent progress, byte ranges, API validation and credential boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "aside-test-"));
  const store = new Store(root);
  store.put({
    id: "test",
    title: "test",
    createdAt: "now",
    durationMs: 10000,
    status: "ready",
    stage: "ready",
    progress: 1,
  });
  await store.objects.put("episodes/test/original", [
    Buffer.from("0123456789"),
  ]);
  const app = createApp(store);
  try {
    assert.equal(
      (await app.inject("/api/health")).json().liveConfigured,
      false,
    );
    const range = await app.inject({
      url: "/api/episodes/test/audio",
      headers: { range: "bytes=2-5" },
    });
    assert.equal(range.statusCode, 206);
    assert.equal(range.body, "2345");
    assert.equal(
      (
        await app.inject({
          url: "/api/episodes/test/audio",
          headers: { range: "bytes=100-" },
        })
      ).statusCode,
      416,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/episodes/test/checkpoint",
          method: "PUT",
          payload: { positionMs: -1, history: [] },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/episodes/test/checkpoint",
          method: "PUT",
          payload: { positionMs: 4500, resumeMs: 1000, history: [] },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await app.inject("/api/episodes/test/checkpoint")).json().resumeMs,
      1000,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/episodes",
          headers: { origin: "https://evil.example" },
        })
      ).statusCode,
      403,
    );
    const again = new Store(root);
    assert.equal(again.checkpoint("test").positionMs, 4500);
    again.close();
  } finally {
    await app.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("real multipart upload persists playable WAV and blocks analysis without key", async () => {
  const root = await mkdtemp(join(tmpdir(), "aside-upload-"));
  const store = new Store(root);
  const app = createApp(store);
  const wav = Buffer.alloc(44 + 4800);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(4800, 40);
  const boundary = "aside-test-boundary";
  const multipart = (bytes: Buffer) =>
    Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="test.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/episodes",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipart(wav),
    });
    assert.equal(res.statusCode, 201, res.body);
    const id = res.json().id;
    assert.equal(store.get(id)?.status, "blocked");
    const audio = await app.inject(`/api/episodes/${id}/audio`);
    assert.equal(audio.headers["content-type"], "audio/wav");
    assert.deepEqual(audio.rawPayload, wav);
    const bad = await app.inject({
      method: "POST",
      url: "/api/episodes",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipart(Buffer.from("not audio")),
    });
    assert.equal(bad.statusCode, 400);
    assert.equal(store.list().length, 1);
  } finally {
    await app.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("upload keeps embedded artwork as a bounded JPEG cover; plain audio gets none", async () => {
  const root = await mkdtemp(join(tmpdir(), "aside-cover-"));
  const store = new Store(root);
  const app = createApp(store);
  const boundary = "aside-cover-boundary";
  const upload = async (name: string, picture: boolean) => {
    const path = join(root, name);
    execFileSync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-t", "1", "-i", "anullsrc=r=24000:cl=mono",
      ...(picture
        ? ["-f", "lavfi", "-i", "color=c=red:s=1200x800:d=1", "-map", "0:a", "-map", "1:v", "-frames:v", "1", "-c:v", "png", "-disposition:v", "attached_pic"]
        : []),
      "-c:a", "libmp3lame", "-id3v2_version", "3", path,
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/api/episodes",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${name}"\r\nContent-Type: audio/mpeg\r\n\r\n`,
        ),
        await readFile(path),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json();
  };
  try {
    const withCover = await upload("cover.mp3", true);
    assert.equal(withCover.cover, true);
    const cover = await app.inject(`/api/episodes/${withCover.id}/cover`);
    assert.equal(cover.statusCode, 200);
    assert.equal(cover.headers["content-type"], "image/jpeg");
    const saved = join(root, "served.jpg");
    await writeFile(saved, cover.rawPayload);
    assert.equal(
      execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height", "-of", "csv=p=0", saved])
        .toString()
        .trim(),
      "mjpeg,600,400",
    );
    const plain = await upload("plain.mp3", false);
    assert.equal(plain.cover, undefined);
    assert.equal(
      (await app.inject(`/api/episodes/${plain.id}/cover`)).statusCode,
      404,
    );
  } finally {
    await app.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("voice usage accumulates per session and repeated final events do not double count", async () => {
  const root = await mkdtemp(join(tmpdir(), "aside-usage-"));
  const store = new Store(root);
  try {
    store.recordUsage("e", "session-a", 20, false);
    store.recordUsage("e", "session-a", 25, true);
    store.recordUsage("e", "session-a", 25, true);
    store.recordUsage("e", "session-a", 10, false);
    store.recordUsage("e", "session-b", 30, true);
    const usage = store.usage("e");
    assert.equal(usage.length, 2);
    assert.equal(
      usage.reduce((n, r) => n + Number(r.seconds), 0),
      55,
    );
    assert.equal(usage[0].finalized, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("first-question upload uses transient WAV; new Live request forwards conversation history", async () => {
  let received: Buffer | undefined, history: unknown;
  const voice: BackendServices["voice"] = {
    async transcribeQuestion(audio: Buffer) {
      received = audio;
      return "完整问题";
    },
    async createLive(
      _sdp: string,
      _analysis: import("@aside/engine/core").Analysis,
      _at: number,
      h: import("@aside/engine/core").Turn[] = [],
    ) {
      history = h;
      return { session: { id: "test-session" }, transport: { sdp: "answer" } };
    },
  };
  const root = await mkdtemp(join(tmpdir(), "aside-first-"));
  const store = new Store(root);
  store.put({
    id: "test",
    title: "test",
    createdAt: "now",
    durationMs: 10000,
    status: "ready",
    stage: "ready",
    progress: 1,
    analysis: {
      version: "v1",
      source: "demo",
      passages: [],
      anchors: [],
      speakers: [],
      summary: "",
      hostStyle: "",
      voice: "feminine",
      voiceReason: "test",
    },
  });
  const app = createApp(store, fakeServices({ voice }));
  try {
    const wav = Buffer.alloc(48);
    wav.write("RIFF");
    wav.write("WAVE", 8);
    const boundary = "first-question";
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="question.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
      ),
      wav,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const r = await app.inject({
      method: "POST",
      url: "/api/episodes/test/transcribe-question",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().text, "完整问题");
    assert.deepEqual(received, wav);
    const h = [
      { role: "user", text: "前面的问题" },
      { role: "assistant", text: "前面的解释" },
    ];
    const live = await app.inject({
      method: "POST",
      url: "/api/episodes/test/live",
      payload: { sdp: "offer", atMs: 1000, history: h },
    });
    assert.equal(live.statusCode, 200, live.body);
    assert.deepEqual(history, h);
  } finally {
    await app.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("question endpoint streams progress and terminal success or error, preserving JSON clients", async () => {
  let fail = false;
  const questions: BackendServices["questions"] = {
    async answer(...args) {
      args[3]?.("working");
      await new Promise((r) => setTimeout(r, 10));
      args[3]?.("searching");
      if (fail) throw Error("lookup failed");
      return {
        revision: args[1].revision,
        answer: "English answer",
        action: "answer" as const,
        sources: [],
        tools: ["search_podcast"],
      };
    },
  };
  const root = await mkdtemp(join(tmpdir(), "aside-progress-"));
  const store = new Store(root);
  store.put({
    id: "progress",
    title: "test",
    createdAt: "now",
    durationMs: 1000,
    status: "ready",
    stage: "ready",
    progress: 1,
    analysis: {
      version: "1",
      passages: [],
      anchors: [],
      summary: "",
      hostStyle: "",
      speakers: [],
      voice: "masculine",
      voiceReason: "test",
      source: "provider",
    },
  });
  const app = createApp(store, fakeServices({ questions }));
  const payload = {
    revision: 7,
    atMs: 0,
    history: [{ role: "user", text: "What is this?" }],
  };
  try {
    const normal = await app.inject({
      method: "POST",
      url: "/api/episodes/progress/question",
      payload,
    });
    assert.equal(normal.json().answer, "English answer");
    for (const failure of [false, true]) {
      fail = failure;
      const response = await app.inject({
        method: "POST",
        url: "/api/episodes/progress/question",
        payload,
        headers: { accept: "application/x-ndjson" },
      });
      assert.equal(response.statusCode, 200);
      const events = response.body
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        events.slice(0, 2).map((e) => e.phase),
        ["working", "searching"],
      );
      assert.equal(events.at(-1).type, failure ? "error" : "result");
    }
  } finally {
    await app.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the question endpoint carries validated controls and playback context through NDJSON", async () => {
  const { QuestionService } = await import("../backend/src/question-service.js");
  const { createPlayerConfig } = await import("@aside/engine/player");
  const { readQuestion } = await import("../frontend/src/question-stream.js");
  const root = await mkdtemp(join(tmpdir(), "aside-remote-"));
  const store = new Store(root);
  store.put({ id: "remote", title: "test", createdAt: "now", durationMs: 60000, status: "ready", stage: "ready", progress: 1,
    analysis: { version: "1", source: "demo", summary: "", hostStyle: "", speakers: [], passages: [], anchors: [], voice: "feminine", voiceReason: "test" } });
  const player = { turnId: "voice-turn", source: "voice" as const, positionMs: 15000, wasPlaying: true, audibleSource: "podcast" as const, config: createPlayerConfig() };
  const questions = new QuestionService({ async reply(input) {
    assert.deepEqual(input.context?.player, player);
    return { id: "response", answer: "", sources: [], searchedWeb: false, calls: [{ id: "command", name: "control_podcast", arguments: '{"commands":[{"type":"set_volume","volume":0.4}]}' }] };
  } });
  const app = createApp(store, fakeServices({ questions }));
  try {
    const response = await app.inject({ method: "POST", url: "/api/episodes/remote/question", headers: { accept: "application/x-ndjson" }, payload: { atMs: 15000, revision: 3, player, history: [{ role: "user", text: "Turn the podcast down to forty percent" }] } });
    assert.equal(response.statusCode, 200, response.body);
    const result = await readQuestion(new Response(response.body, { headers: { "Content-Type": String(response.headers["content-type"]) } }), () => {}, 3);
    assert.equal(result.action, "player_control");
    if (result.action !== "player_control") assert.fail("expected remote command");
    assert.deepEqual(result.commands, [{ type: "set_volume", volume: 0.4 }]);
    assert.equal(result.commandId, "voice-turn:command");
  } finally {
    await app.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
