/** Local-only real Worker harness. Never bundled into production or the mobile app. */
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import {
  Miniflare,
  convertV4MiniflareOptions,
  WebSocketPair,
  Response as WorkerResponse,
} from "miniflare";
import { CloudStore } from "../../cloudflare/src/store.ts";
import { mediaApp } from "../../backend/src/container/app.ts";
import { streamedResponse } from "../../tests/fixtures/streamed-response.ts";
let mf, db, bucket;
const root = await mkdtemp(join(tmpdir(), "aside-mobile-fixture-"));
const media = mediaApp(join(root, "media"));
const port = Number(process.env.PORT ?? 4311);
const origin = `http://127.0.0.1:${port}`;
const networkCalls = [],
  controlEvents = [],
  usedProofs = new Set();
const acknowledgeClose = true;
const voicePeers = new Map();
const deviceEvidence = new Map();
const rtcOrigin = `http://127.0.0.1:${Number(process.env.RTC_PORT ?? 4312)}`;
let voiceTurn = 0;
const googleIdentity = {
  sub: "test-google",
  email: "test@example.com",
  email_verified: true,
  name: "Test",
};
const bundle = await build({
  entryPoints: ["mobile/tests/worker.ts"],
  plugins: [
    {
      name: "fixture-diagnostics",
      setup(builder) {
        builder.onLoad(
          { filter: /cloudflare\/src\/api\.ts$/ },
          async ({ path }) => ({
            contents: (await readFile(path, "utf8")).replace(
              'console.error("Aside API request failed", {',
              'console.error("Local fixture error:", String(error)); console.error("Aside API request failed", {',
            ),
            loader: "ts",
          }),
        );
      },
    },
  ],
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  conditions: ["workerd", "worker", "browser"],
  external: ["cloudflare:*", "node:*"],
});
mf = new Miniflare(
  convertV4MiniflareOptions({
    port,
    host: "127.0.0.1",
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-09-12",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: ["DB"],
    r2Buckets: ["AUDIO"],
    email: {
      send_email: [
        {
          name: "EMAIL",
          allowed_sender_addresses: ["login@auth.asidefm.com"],
        },
      ],
    },
    durableObjects: {
      MEDIA: { className: "TestMedia", useSQLite: true },
      LIVE: { className: "TestLive", useSQLite: true },
    },
    workflows: {
      ANALYSIS: { name: "analysis-test", className: "EpisodeAnalysis" },
      PROD_ANALYSIS: {
        name: "production-analysis-test",
        className: "EpisodeAnalysis",
      },
    },
    bindings: {
      MOBILE_AUDIO_ENABLED: "true",
      APP_ORIGIN: origin,
      TURNSTILE_SITE_KEY: "test-site",
      TURNSTILE_SECRET_KEY: "test-secret",
      SESSION_SECRET: "local-test-secret-at-least-32-characters",
      OPENAI_API_KEY: "test-placeholder",
      ALLOW_UPLOADS: "true",
      AUTH_EMAIL_FROM: "login@auth.asidefm.com",
      ASIDE_LIVE_ACCOUNT_SESSION_SECONDS:
        process.env.VOICE_SESSION_SECONDS ?? "120",
      TRIAL_DAILY_LIMITS: process.env.TRIAL_DAILY_LIMITS ?? "true",
      GOOGLE_CLIENT_ID: "google-test-id",
      GOOGLE_CLIENT_SECRET: "google-test-secret",
    },
    serviceBindings: { ASSETS: () => new Response("assets") },
    outboundService: async (request) => {
      networkCalls.push(new URL(request.url).pathname);
      // Consume each synthetic upstream request before replying, including its
      // complete recording body, as a real HTTP service would.
      const payload = ["GET", "HEAD"].includes(request.method)
        ? undefined
        : Buffer.from(await request.arrayBuffer());
      const bodyText = payload?.toString("utf8") ?? "";
      if (new URL(request.url).hostname === "test-voice-control") {
        if (new URL(request.url).pathname === "/__fixture/device") {
          if (request.method === "GET")
            return Response.json(Object.fromEntries(deviceEvidence));
          const sample = JSON.parse(bodyText);
          const samples = deviceEvidence.get(sample.platform) ?? [];
          samples.push(sample);
          deviceEvidence.set(sample.platform, samples.slice(-3000));
          return Response.json({ ok: true });
        }
        if (request.method === "GET")
          return Response.json({ sessions: [...voicePeers.keys()] });
        const action = JSON.parse(bodyText);
        const sessionId = action.sessionId ?? [...voicePeers.keys()].at(-1);
        const socket = voicePeers.get(sessionId);
        if (!socket)
          return Response.json(
            { error: "No attached fixture session" },
            { status: 409 },
          );
        const send = (event) => socket.send(JSON.stringify(event));
        const delegation = `fixture-${++voiceTurn}`;
        const response = (event) =>
          send({ type: "response.event", delegation_id: delegation, event });
        const text = action.text ?? "What is a biography?";
        const answer = action.answer ?? "A short answer";
        const rtc = async (body) => {
          const result = await fetch(`${rtcOrigin}/control`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId, ...body }),
          });
          if (!result.ok) throw Error(`RTC fixture rejected ${result.status}`);
          return result.json();
        };
        if (action.action === "status")
          return Response.json(await rtc({ action: "status" }));
        if (
          !["question", "variant", "duplicate", "ignore", "resume"].includes(action.action)
        )
          return Response.json(
            { error: "Unknown fixture action" },
            { status: 400 },
          );
        // Supplier timestamps describe the real media clock. Artificially
        // adjacent offsets merge distinct questions into one utterance.
        const { outputSamples } = await rtc({ action: "status" });
        const endMs = Math.round(outputSamples / 48);
        const input = {
          type: "session.input_transcript.delta",
          delta: text,
          start_ms: Math.max(0, endMs - 500),
          end_ms: endMs,
        };
        if (action.action !== "duplicate") {
          await rtc({ action: "event", event: input });
          send(input);
        }
        send({
          type: "session.delegation.created",
          delegation: {
            id: delegation,
            target: "responses",
            type: "delegation",
          },
        });
        if (action.action === "variant") {
          // Real device pattern: two complete backend formulations, one spoken
          // reply. The second cannot re-admit the question or replace its anchor.
          response({ type: "response.created", response: {} });
          response({ type: "response.output_text.delta", delta: "An earlier unspoken formulation of this answer." });
          response({ type: "response.completed", response: {} });
          await new Promise(resolve => setTimeout(resolve, 150));
          const variantId = `${delegation}-variant`;
          send({ type: "session.delegation.created", delegation: { id: variantId, target: "responses" } });
          for (const event of [
            { type: "response.created", response: {} },
            { type: "response.output_text.delta", delta: answer },
            { type: "response.completed", response: {} },
          ]) send({ type: "response.event", delegation_id: variantId, event });
          const evidence = await rtc({ action: "answer", text: answer, duration: 2 });
          send({ type: "session.output_transcript.delta", delta: answer });
          return Response.json({ ok: true, delegation, ...evidence });
        }
        if (action.action === "duplicate") {
          response({ type: "response.created", response: {} });
          response({ type: "response.output_text.delta", delta: answer });
          response({ type: "response.completed", response: { output: [] } });
          return Response.json(
            await rtc({ action: "answer", text: answer, duration: 1 }),
          );
        }
        if (action.action === "question") {
          // Deliberately start real audio BEFORE the server admits the reply.
          // A muted media track would lose this prefix; the native PCM gate must retain it.
          const evidence = await rtc({
            action: "answer",
            text: answer,
            duration: 2,
          });
          await new Promise((resolve) => setTimeout(resolve, 500));
          response({
            type: "response.output_item.done",
            item: {
              type: "function_call",
              call_id: `${delegation}-tool`,
              name: "search_podcast",
              arguments: JSON.stringify({ query: "curiosity" }),
            },
          });
          response({ type: "response.completed", response: { output: [] } });
          await new Promise((resolve) => setTimeout(resolve, 200));
          response({ type: "response.created", response: {} });
          response({ type: "response.output_text.delta", delta: answer });
          response({ type: "response.completed", response: { output: [] } });
          return Response.json({ ok: true, delegation, ...evidence });
        }
        response({
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: `${delegation}-tool`,
            name:
              action.action === "ignore" ? "ignore_input" : "resume_podcast",
            arguments: "{}",
          },
        });
        response({ type: "response.completed", response: { output: [] } });
        return Response.json({ ok: true, delegation });
      }
      if (request.url === "https://oauth2.googleapis.com/token")
        return Response.json({ access_token: "google-test-access" });
      if (request.url === "https://openidconnect.googleapis.com/v1/userinfo")
        return Response.json(googleIdentity);
      if (request.url.endsWith("/siteverify")) {
        const { response: token } = JSON.parse(bodyText);
        const data = JSON.parse(token);
        const success = !usedProofs.has(token);
        usedProofs.add(token);
        return Response.json({
          success,
          hostname: "aside.test",
          action: "aside-trial",
          ...data,
        });
      }
      if (request.url.endsWith("/attach")) {
        const pair = new WebSocketPair();
        pair[1].accept();
        const sessionId = new URL(request.url).pathname.split("/").at(-2);
        voicePeers.set(sessionId, pair[1]);
        pair[1].addEventListener("close", () => voicePeers.delete(sessionId));
        pair[1].addEventListener("message", (event) => {
          const data = JSON.parse(event.data);
          controlEvents.push(data);
          if (data.type === "session.close" && acknowledgeClose)
            pair[1].send(JSON.stringify({ type: "session.closed" }));
        });
        return new WorkerResponse(null, { status: 101, webSocket: pair[0] });
      }
      if (
        request.url.endsWith("/responses") &&
        Number(process.env.QUESTION_DELAY_MS ?? 0) > 0
      )
        await new Promise((resolve) =>
          setTimeout(resolve, Number(process.env.QUESTION_DELAY_MS)),
        );
      if (
        request.url.endsWith("/responses") &&
        JSON.parse(payload.toString()).stream
      )
        return streamedResponse(
          "A short answer",
          Number(process.env.STREAM_DELAY_MS ?? 1500),
        );
      if (request.url.endsWith("/responses"))
        return Response.json({
          id: "response-test",
          output_text: "A short answer",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "A short answer",
                  annotations: [],
                },
              ],
            },
          ],
        });
      if (new URL(request.url).hostname === "test-media") {
        const url = new URL(request.url);
        const result = await media.inject({
          method: request.method,
          url: url.pathname + url.search,
          headers: Object.fromEntries(request.headers),
          payload,
        });
        return new Response(result.rawPayload, {
          status: result.statusCode,
          headers: result.headers,
        });
      }
      if (request.url.endsWith("/live/sessions")) {
        return fetch(`${rtcOrigin}/live`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: bodyText,
        });
      }
      if (request.url.endsWith("/audio/transcriptions"))
        return Response.json({
          text: "Question",
          segments: [{ start: 0, end: 1, text: "A sentence" }],
          words: [],
        });
      if (request.url.endsWith("/chat/completions"))
        return Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  summary: "Summary",
                  hostStyle: "Calm",
                  speakers: [],
                  groups: [{ firstId: "p-0-0", lastId: "p-0-0" }],
                }),
              },
            },
          ],
        });
      throw Error("Unexpected outbound request");
    },
  }),
);
db = await mf.getD1Database("DB");
bucket = await mf.getR2Bucket("AUDIO");
const migrationDir = "cloudflare/migrations";
const migrationFiles = (await readdir(migrationDir))
  .filter((file) => file.endsWith(".sql"))
  .sort();
const sql = (
  await Promise.all(
    migrationFiles.map((file) => readFile(join(migrationDir, file), "utf8")),
  )
).join("\n");
for (const statement of sql
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean))
  await db.prepare(statement).run();
await db.prepare("CREATE TABLE test_jobs(id TEXT PRIMARY KEY)").run();
const path = join(root, "sample.wav");
execFileSync("ffmpeg", [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=220:duration=180",
  "-ac",
  "1",
  "-ar",
  "16000",
  path,
]);
const store = new CloudStore(db, bucket);
const analysis = {
  version: "fixture",
  source: "demo",
  summary: "A sample for mobile tests",
  hostStyle: "Calm",
  voice: "masculine",
  voiceReason: "test",
  speakers: [],
  passages: Array.from({ length: 18 }, (_, i) => ({
    id: `p${i}`,
    startMs: i * 10000,
    endMs: (i + 1) * 10000,
    text: `Passage ${i + 1}. Curiosity helps us understand what we hear.`,
    speaker: "host",
  })),
  anchors: Array.from({ length: 18 }, (_, i) => ({
    id: `a${i}`,
    startMs: i * 10000,
    endMs: (i + 1) * 10000,
    text: "A complete thought.",
    confidence: 1,
  })),
};
const ep = {
  id: "mobile-sample",
  title: "Curiosity — mobile sample",
  createdAt: new Date().toISOString(),
  durationMs: 180000,
  mimeType: "audio/wav",
  status: "ready",
  stage: "ready",
  progress: 1,
};
await store.records.put("episodes/mobile-sample/analysis.json", analysis);
await db
  .prepare(
    "INSERT INTO episodes(id,owner_id,public,metadata,analysis_key,created_at) VALUES(?,?,?,?,?,?)",
  )
  .bind(
    ep.id,
    "fixture",
    1,
    JSON.stringify(ep),
    "episodes/mobile-sample/analysis.json",
    ep.createdAt,
  )
  .run();
await bucket.put("episodes/mobile-sample/original", await readFile(path));
// A real 31-minute media file for sustained native/background playback checks.
const longPath = join(root, "long.m4a");
execFileSync("ffmpeg", [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "anullsrc=r=48000:cl=mono",
  "-t",
  "1860",
  "-c:a",
  "aac",
  "-b:a",
  "32000",
  longPath,
]);
const longEpisode = {
  ...ep,
  id: "mobile-long",
  title: "A quiet half hour",
  durationMs: 1860000,
  mimeType: "audio/mp4",
};
await store.records.put("episodes/mobile-long/analysis.json", {
  ...analysis,
  passages: [
    {
      ...analysis.passages[0],
      endMs: 1860000,
      text: "A quiet audio fixture for uninterrupted background listening.",
    },
  ],
  anchors: [{ ...analysis.anchors[0], endMs: 1860000 }],
});
await db
  .prepare(
    "INSERT INTO episodes(id,owner_id,public,metadata,analysis_key,created_at) VALUES(?,?,?,?,?,?)",
  )
  .bind(
    longEpisode.id,
    "fixture",
    1,
    JSON.stringify(longEpisode),
    "episodes/mobile-long/analysis.json",
    ep.createdAt,
  )
  .run();
await bucket.put("episodes/mobile-long/original", await readFile(longPath));
console.log("Mobile fixture API:", String(await mf.ready), "OTP: 12345678");
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void mf
      .dispose()
      .then(() => media.close())
      .then(() => rm(root, { recursive: true, force: true }))
      .then(() => process.exit());
  });
