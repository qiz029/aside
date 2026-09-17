import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createHmac } from "node:crypto";
import { build } from "esbuild";
import {
  Miniflare,
  convertV4MiniflareOptions,
  WebSocketPair,
  Response as WorkerResponse,
} from "miniflare";
import { CloudStore } from "../../cloudflare/src/store.ts";
import { analyzeEpisode } from "../../cloudflare/src/pipeline.ts";
import { admitAudio, mediaApp } from "../../backend/src/container/app.ts";
import { rollupDailyStats } from "../../cloudflare/src/stats.ts";
import { budget } from "../../cloudflare/src/trial.ts";
let mf, db, bucket;
let networkCalls = [];
let acknowledgeClose = true;
let attachGone = false;
let attachBroken = false;
let createUnknown = false;
let rejectLive = false;
let googleIdentity = {
  sub: "google-sub-1",
  email: "google-user@gmail.com",
  email_verified: true,
  name: "Google Listener",
  picture: "https://lh3.googleusercontent.com/a/test",
};
const controlEvents = [];
const sidebands = new Map();
let liveReply;
const usedProofs = new Set();
const origin = "https://aside.test";
const testerIp = "192.0.2.10";
const testerIpHash = createHmac("sha256", "local-test-secret-at-least-32-characters").update(testerIp).digest("hex");
before(async () => {
  const shell = await readFile("frontend/index.html", "utf8");
  const bundle = await build({
    entryPoints: ["tests/cloudflare/worker.mjs"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*"],
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
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
        ANALYSIS: { name: "analysis-test", className: "TestAnalysis" },
        PROD_ANALYSIS: {
          name: "production-analysis-test",
          className: "EpisodeAnalysis",
        },
      },
      bindings: {
        APP_ORIGIN: origin,
        TURNSTILE_SITE_KEY: "test-site",
        TURNSTILE_SECRET_KEY: "test-secret",
        SESSION_SECRET: "local-test-secret-at-least-32-characters",
        TRIAL_TEST_IP_HASHES: testerIpHash,
        OPENAI_API_KEY: "test-placeholder",
        ALLOW_UPLOADS: "true",
        AUTH_EMAIL_FROM: "login@auth.asidefm.com",
        GOOGLE_CLIENT_ID: "google-test-id",
        GOOGLE_CLIENT_SECRET: "google-test-secret",
        ADMIN_KEY: "admin-test-key-at-least-32-characters",
      },
      serviceBindings: {
        // Stand in for the static asset binding: the SEO routes splice their
        // head and body into the real built shell.
        ASSETS: (request) =>
          ["/", "/index.html"].includes(new URL(request.url).pathname)
            ? new Response(shell, {
                headers: { "content-type": "text/html; charset=utf-8" },
              })
            : new Response("missing asset", { status: 404 }),
      },
      outboundService: async (request) => {
        networkCalls.push(new URL(request.url).pathname);
        if (request.url === "https://oauth2.googleapis.com/token")
          return Response.json({ access_token: "google-test-access" });
        if (request.url === "https://openidconnect.googleapis.com/v1/userinfo")
          return Response.json(googleIdentity);
        if (request.url.endsWith("/siteverify")) {
          const { response: token } = await request.json();
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
        if (request.url.endsWith("/attach") && attachGone)
          return new Response(null, { status: 404 });
        // A transient supplier failure: no socket, but no verdict either.
        if (request.url.endsWith("/attach") && attachBroken)
          return new Response("upstream unavailable", { status: 500 });
        if (request.url.endsWith("/attach")) {
          const pair = new WebSocketPair();
          pair[1].accept();
          sidebands.set(new URL(request.url).pathname.split("/").at(-2), pair[1]);
          pair[1].addEventListener("message", (event) => {
            const data = JSON.parse(event.data);
            controlEvents.push(data);
            if (data.type === "session.close" && acknowledgeClose)
              pair[1].send(JSON.stringify({ type: "session.closed" }));
          });
          return new WorkerResponse(null, { status: 101, webSocket: pair[0] });
        }
        if (request.url.endsWith("/responses") && liveReply) return liveReply(await request.json());
        if (request.url.endsWith("/responses"))
          return Response.json({
            id: "response-test",
            service_tier: "priority",
            usage: {
              input_tokens: 1200,
              input_tokens_details: { cached_tokens: 500, cache_write_tokens: 0 },
              output_tokens: 400,
              output_tokens_details: { reasoning_tokens: 330 },
              total_tokens: 1600,
            },
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
        // An ambiguous supplier failure: the session may or may not exist.
        if (request.url.endsWith("/live/sessions") && createUnknown)
          return new Response("upstream error", { status: 500 });
        if (request.url.endsWith("/live/sessions")) {
          if (rejectLive) return new Response("Invalid SDP", { status: 400 });
          return Response.json({
            session: { id: crypto.randomUUID() },
            transport: { sdp: "test-answer" },
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
  // Read the directory in order rather than listing files: a new migration must
  // not silently be missing from the schema these tests run against.
  const dir = "cloudflare/migrations";
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  assert.ok(files.length >= 6, `expected migrations, found ${files.join()}`);
  const sql = (
    await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")))
  ).join("\n");
  for (const statement of sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean))
    await db.prepare(statement).run();
  await db.prepare("CREATE TABLE test_jobs(id TEXT PRIMARY KEY)").run();
});
after(async () => {
  await mf?.dispose();
});
beforeEach(async () => {
  await db.prepare("DELETE FROM budgets WHERE bucket LIKE 'burst:%'").run();
});
async function visitor(verified = true) {
  const response = await mf.dispatchFetch(origin + "/api/health");
  assert.equal(response.status, 200, await response.clone().text());
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const id = cookie.split("=")[1].split(".")[0];
  const user = {
    cookie,
    id,
    request: (path, method = "GET", body, headers = {}) =>
      mf.dispatchFetch(origin + path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          cookie,
          origin,
          "content-type": "application/json",
          ...headers,
        },
      }),
  };
  if (verified) {
    const result = await user.request("/api/trial", "POST", {
      token: JSON.stringify({ cdata: id, nonce: crypto.randomUUID() }),
    });
    assert.equal(result.status, 200, await result.text());
  }
  return user;
}
async function setTestLoginCode(email) {
  // The email binding is simulated locally. Fix the stored challenge so the
  // authentication flow can be exercised without reading simulator temp files.
  const code = "12345678";
  const codeHash = createHash("sha256")
    .update(`local-test-secret-at-least-32-characters:${email}:${code}`)
    .digest("hex");
  const result = await db
    .prepare("UPDATE auth_codes SET code_hash=? WHERE email=?")
    .bind(codeHash, email)
    .run();
  assert.equal(result.meta.changes, 1);
  return code;
}
async function signedInAccount() {
  const guest = await visitor(false);
  const email = `upload-${crypto.randomUUID()}@example.com`;
  const sent = await guest.request("/api/auth/email/start", "POST", { email });
  assert.equal(sent.status, 200, await sent.clone().text());
  const code = await setTestLoginCode(email);
  const verified = await guest.request("/api/auth/email/verify", "POST", {
    email,
    code,
  });
  assert.equal(verified.status, 200, await verified.clone().text());
  const authCookie = verified.headers.get("set-cookie").split(";")[0];
  const id = (await verified.json()).user.id;
  const cookie = `${guest.cookie}; ${authCookie}`;
  const request = (path, method = "GET", body, headers = {}) =>
    guest.request(path, method, body, { cookie, ...headers });
  return { id, cookie, authCookie, request };
}
const analysis = {
  version: "test",
  source: "demo",
  passages: [],
  anchors: [],
  summary: "",
  hostStyle: "",
  speakers: [],
  voice: "masculine",
  voiceReason: "test",
};
async function seed(id, owner, shared = false, ready = true) {
  const episode = {
    id,
    title: "Episode",
    createdAt: new Date().toISOString(),
    durationMs: 10000,
    status: ready ? "ready" : "queued",
    stage: "ready",
    progress: ready ? 1 : 0,
  };
  const key = `episodes/${id}/analysis.json`;
  if (ready) await new CloudStore(db, bucket).records.put(key, analysis);
  await db
    .prepare(
      "INSERT INTO episodes(id,owner_id,public,metadata,analysis_key,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(
      id,
      owner,
      shared ? 1 : 0,
      JSON.stringify(episode),
      ready ? key : null,
      episode.createdAt,
    )
    .run();
  await bucket.put(`episodes/${id}/original`, "0123456789");
}
test("email login creates a stable owner, claims visitor episodes, and protects profile", async () => {
  const guest = await visitor(false);
  await seed("email-private", guest.id);
  const email = "listener@example.com";
  const sent = await guest.request("/api/auth/email/start", "POST", { email });
  assert.equal(sent.status, 200, await sent.clone().text());
  const loginCode = await setTestLoginCode(email);
  const verified = await guest.request("/api/auth/email/verify", "POST", {
    email,
    code: loginCode,
  });
  assert.equal(verified.status, 200, await verified.clone().text());
  const auth = verified.headers.get("set-cookie").split(";")[0];
  const account = (await verified.json()).user;
  assert.equal(account.email, email);
  assert.equal(
    (
      await guest.request("/api/auth/email/verify", "POST", {
        email,
        code: loginCode,
      })
    ).status,
    400,
  );
  const other = await visitor(false);
  assert.equal(
    (await other.request("/api/episodes/email-private")).status,
    404,
  );
  assert.equal((await other.request("/api/profile")).status, 401);
  const withAuth = (path, method = "GET", body, headers = {}) =>
    other.request(path, method, body, {
      cookie: `${other.cookie}; ${auth}`,
      ...headers,
    });
  assert.equal((await withAuth("/api/episodes/email-private")).status, 200);
  const edited = await withAuth("/api/profile", "PATCH", {
    alias: "Thoughtful listener",
    description: "I like history podcasts.",
  });
  assert.equal(edited.status, 200, await edited.clone().text());
  assert.equal((await edited.json()).user.alias, "Thoughtful listener");
  const avatar = await withAuth("/api/profile/avatar", "PUT", undefined, {
    "content-type": "image/png",
  });
  assert.equal(avatar.status, 400);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  const uploaded = await mf.dispatchFetch(origin + "/api/profile/avatar", {
    method: "PUT",
    headers: {
      cookie: `${other.cookie}; ${auth}`,
      origin,
      "content-type": "image/png",
    },
    body: png,
  });
  assert.equal(uploaded.status, 200, await uploaded.text());
  const fetched = await withAuth("/api/profile/avatar");
  assert.equal(fetched.status, 200);
  assert.equal(fetched.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), png);
  const signedOut = await withAuth("/api/auth/logout", "POST");
  assert.equal(signedOut.status, 200);
  assert.equal((await withAuth("/api/profile")).status, 401);
  assert.equal((await withAuth("/api/episodes/email-private")).status, 404);
});

test("parallel guesses cannot exceed the email code attempt limit", async () => {
  const guest = await visitor(false);
  const email = "attempt-limit@example.com";
  await guest.request("/api/auth/email/start", "POST", { email });
  const loginCode = await setTestLoginCode(email);
  const wrong = "00000000";
  const guesses = await Promise.all(
    Array.from({ length: 10 }, () =>
      guest.request("/api/auth/email/verify", "POST", { email, code: wrong }),
    ),
  );
  assert.ok(guesses.every((response) => response.status === 400));
  const row = await db
    .prepare("SELECT attempts FROM auth_codes WHERE email=?")
    .bind(email)
    .first();
  assert.equal(row.attempts, 5);
  assert.equal(
    (
      await guest.request("/api/auth/email/verify", "POST", {
        email,
        code: loginCode,
      })
    ).status,
    400,
  );
});

test("Google callback validates state and links a verified email to one account", async () => {
  googleIdentity = {
    sub: "google-sub-1",
    email: "google-user@gmail.com",
    email_verified: true,
    name: "Google Listener",
    picture: "https://lh3.googleusercontent.com/a/test",
  };
  const guest = await visitor(false);
  const start = await mf.dispatchFetch(origin + "/api/auth/google", {
    headers: { cookie: guest.cookie },
    redirect: "manual",
  });
  assert.equal(start.status, 302);
  const googleUrl = new URL(start.headers.get("location"));
  assert.equal(
    googleUrl.searchParams.get("redirect_uri"),
    origin + "/api/auth/google/callback",
  );
  const state = googleUrl.searchParams.get("state");
  const stateCookie = start.headers.get("set-cookie").split(";")[0];
  const forged = await mf.dispatchFetch(
    `${origin}/api/auth/google/callback?state=${state}&code=test`,
    { headers: { cookie: guest.cookie } },
  );
  assert.equal(forged.status, 400);
  const callback = await mf.dispatchFetch(
    `${origin}/api/auth/google/callback?state=${state}&code=test`,
    {
      headers: {
        cookie: `${guest.cookie}; ${stateCookie}`,
        "sec-fetch-site": "cross-site",
      },
      redirect: "manual",
    },
  );
  assert.equal(callback.status, 302, await callback.clone().text());
  assert.equal(callback.headers.get("location"), origin + "/?profile=1");
  const cookie = callback.headers
    .get("set-cookie")
    .match(/aside_auth=[a-f0-9]{64}/)?.[0];
  assert.ok(cookie);
  const profile = await guest.request("/api/profile", "GET", undefined, {
    cookie: `${guest.cookie}; ${cookie}`,
  });
  assert.equal((await profile.json()).user.alias, "Google Listener");
  const replay = await mf.dispatchFetch(
    `${origin}/api/auth/google/callback?state=${state}&code=test`,
    { headers: { cookie: `${guest.cookie}; ${stateCookie}` } },
  );
  assert.equal(replay.status, 400);
});

test("third-party Google email requires current email proof before linking", async () => {
  googleIdentity = {
    sub: "external-google-sub",
    email: "external@example.com",
    email_verified: true,
    name: "External Listener",
  };
  const guest = await visitor(false);
  const start = await mf.dispatchFetch(origin + "/api/auth/google", {
    headers: { cookie: guest.cookie },
    redirect: "manual",
  });
  const state = new URL(start.headers.get("location")).searchParams.get(
    "state",
  );
  const stateCookie = start.headers.get("set-cookie").split(";")[0];
  const rejected = await mf.dispatchFetch(
    `${origin}/api/auth/google/callback?state=${state}&code=test`,
    {
      headers: { cookie: `${guest.cookie}; ${stateCookie}` },
      redirect: "manual",
    },
  );
  assert.equal(
    rejected.headers.get("location"),
    origin + "/?authError=email-verify",
  );
  const email = "external@example.com";
  await guest.request("/api/auth/email/start", "POST", { email });
  const loginCode = await setTestLoginCode(email);
  const verified = await guest.request("/api/auth/email/verify", "POST", {
    email,
    code: loginCode,
  });
  assert.equal(verified.status, 200);
  const auth = verified.headers.get("set-cookie").split(";")[0];
  const linking = await mf.dispatchFetch(origin + "/api/auth/google", {
    headers: { cookie: `${guest.cookie}; ${auth}` },
    redirect: "manual",
  });
  const linkState = new URL(linking.headers.get("location")).searchParams.get(
    "state",
  );
  const linkCookie = linking.headers.get("set-cookie").split(";")[0];
  const linked = await mf.dispatchFetch(
    `${origin}/api/auth/google/callback?state=${linkState}&code=test`,
    {
      headers: { cookie: `${guest.cookie}; ${linkCookie}` },
      redirect: "manual",
    },
  );
  assert.equal(linked.status, 302);
  const identity = await db
    .prepare(
      "SELECT user_id FROM auth_identities WHERE provider='google' AND subject='external-google-sub'",
    )
    .first();
  assert.equal(identity.user_id, (await verified.json()).user.id);
});
test("real Worker + D1/R2 isolate private episodes, public checkpoints and byte ranges", async () => {
  const a = await visitor(),
    b = await visitor();
  await seed("private", a.id);
  await seed("public", "curator", true);
  assert.equal((await b.request("/api/episodes/private")).status, 404);
  assert.equal((await b.request("/api/episodes/private/audio")).status, 404);
  const list = await (await b.request("/api/episodes")).json();
  assert.ok(list.some((e) => e.id === "public"));
  assert.ok(!list.some((e) => e.id === "private"));
  assert.equal(
    (
      await a.request("/api/episodes/public/checkpoint", "PUT", {
        positionMs: 5000,
        history: [],
      })
    ).status,
    200,
  );
  assert.equal(
    await (await b.request("/api/episodes/public/checkpoint")).json(),
    null,
  );
  assert.equal(
    (await (await a.request("/api/episodes/public/checkpoint")).json())
      .positionMs,
    5000,
  );
  const range = await b.request(
    "/api/episodes/public/audio",
    "GET",
    undefined,
    { range: "bytes=2-5" },
  );
  assert.equal(range.status, 206);
  assert.equal(await range.text(), "2345");
  assert.equal(range.headers.get("content-range"), "bytes 2-5/10");
  const suffix = await b.request(
    "/api/episodes/public/audio",
    "GET",
    undefined,
    { range: "bytes=-3" },
  );
  assert.equal(await suffix.text(), "789");
  assert.equal(
    (
      await b.request("/api/episodes/public/audio", "GET", undefined, {
        range: "bytes=99-",
      })
    ).status,
    416,
  );
  assert.equal(
    (
      await b.request(
        "/api/episodes/public/checkpoint",
        "PUT",
        { positionMs: 1, history: [] },
        { origin: "https://evil.test" },
      )
    ).status,
    403,
  );
});
test("checkpoint writes tolerate the production version column and preserve its value", async () => {
  const a = await visitor(), b = await visitor();
  const id = `checkpoint-schema-${crypto.randomUUID()}`;
  await seed(id, "curator", true);
  // Production applied 0006_mobile.sql, which is absent from current main.
  await db.prepare("ALTER TABLE checkpoints ADD COLUMN version INTEGER NOT NULL DEFAULT 0").run();
  try {
    const path = `/api/episodes/${id}/checkpoint`;
    const created = await a.request(path, "PUT", { positionMs: 1000, history: [] });
    assert.equal(created.status, 200, await created.clone().text());
    assert.equal((await (await a.request(path)).json()).positionMs, 1000);
    assert.equal((await db.prepare("SELECT version FROM checkpoints WHERE owner_id=? AND episode_id=?").bind(a.id, id).first()).version, 0);
    await db.prepare("UPDATE checkpoints SET version=42 WHERE owner_id=? AND episode_id=?").bind(a.id, id).run();
    const updated = await a.request(path, "PUT", { positionMs: 2000, history: [] });
    assert.equal(updated.status, 200, await updated.clone().text());
    assert.equal((await (await a.request(path)).json()).positionMs, 2000);
    assert.equal((await db.prepare("SELECT version FROM checkpoints WHERE owner_id=? AND episode_id=?").bind(a.id, id).first()).version, 42);
    assert.equal(await (await b.request(path)).json(), null);
  } finally {
    await db.prepare("ALTER TABLE checkpoints DROP COLUMN version").run();
  }
});

test("signed sessions cannot be forged; quota reservations are atomic under concurrency", async () => {
  const a = await visitor();
  await seed("secret", a.id);
  const forged = a.cookie.replace(/.$/, "x");
  assert.equal(
    (
      await mf.dispatchFetch(origin + "/api/episodes/secret", {
        headers: { cookie: forged },
      })
    ).status,
    404,
  );
  const store = new CloudStore(db, bucket);
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, () => store.reserve("concurrent-test", 3)),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
});
test("multipart upload validates size/ownership and completes idempotently into a real Workflow", async () => {
  const a = await signedInAccount(),
    b = await signedInAccount();
  const init = await a.request("/api/uploads", "POST", {
    title: "Upload",
    size: 44,
  });
  assert.equal(init.status, 201, await init.clone().text());
  const upload = await init.json();
  assert.equal(
    (
      await b.request(`/api/uploads/${upload.id}/complete`, "POST", {
        parts: [],
      })
    ).status,
    404,
  );
  const part = await mf.dispatchFetch(
    origin + `/api/uploads/${upload.id}/part?number=1`,
    {
      method: "PUT",
      headers: { cookie: a.cookie, origin },
      body: new Uint8Array(44),
    },
  );
  assert.equal(part.status, 200, await part.clone().text());
  const parts = [await part.json()];
  const complete = () =>
    a.request(`/api/uploads/${upload.id}/complete`, "POST", { parts });
  assert.equal((await complete()).status, 201);
  assert.equal((await complete()).status, 201);
  assert.equal((await bucket.head(`episodes/${upload.id}/original`)).size, 44);
  const bindings = await mf.getBindings();
  const instance = await bindings.ANALYSIS.get(upload.id);
  for (let i = 0; i < 30; i++) {
    if ((await instance.status()).status === "complete") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal((await instance.status()).status, "complete");
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM test_jobs WHERE id=?")
        .bind(upload.id)
        .first()
    ).n,
    1,
  );
  const invalid = await a.request("/api/uploads", "POST", {
    title: "Bad",
    size: 50,
  });
  const second = await invalid.json();
  const badPart = await mf.dispatchFetch(
    origin + `/api/uploads/${second.id}/part?number=1`,
    {
      method: "PUT",
      headers: { cookie: a.cookie, origin },
      body: new Uint8Array(49),
    },
  );
  assert.equal(badPart.status, 400);
});
test("upload quota allows 100 active or completed files per account per UTC month and frees cancellations", async () => {
  const guest = await visitor();
  assert.equal(
    (await guest.request("/api/uploads", "POST", { title: "Guest", size: 44 })).status,
    401,
  );
  const a = await signedInAccount();
  const now = new Date().toISOString();
  const month = now.slice(0, 7);
  // Earlier uploads this month count; they sit on another day so the site-wide daily cap stays free.
  const earlierDay = now.slice(8, 10) === "01" ? "02" : "01";
  const seedUploads = (count, createdAt, label) =>
    db.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
       INSERT INTO uploads(id,owner_id,upload_id,object_key,title,size,created_at,state)
       SELECT ?||'-'||i,?,'seeded','episodes/'||?||'-'||i||'/original','Earlier',44,?,'complete' FROM n`,
    ).bind(count, `${label}-${a.id}`, a.id, `${label}-${a.id}`, createdAt).run();
  await seedUploads(97, `${month}-${earlierDay}T00:00:00.000Z`, "this-month");
  // Last month's uploads never count toward this month.
  const lastMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2, 15));
  await seedUploads(3, lastMonth.toISOString(), "last-month");
  const starts = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      a.request("/api/uploads", "POST", {
        title: `Episode ${index + 1}`,
        size: 44,
      }),
    ),
  );
  assert.equal(starts.filter((response) => response.status === 201).length, 3);
  const rejected = starts.filter((response) => response.status === 429);
  assert.equal(rejected.length, 5);
  assert.match((await rejected[0].json()).error, /每个账号每月最多上传 100 篇音频/);
  const accepted = await Promise.all(
    starts.filter((response) => response.status === 201).map((response) => response.json()),
  );
  const anotherVisitor = await visitor(false);
  const sameAccount = await anotherVisitor.request(
    "/api/uploads",
    "POST",
    { title: "Same account, new visitor", size: 44 },
    { cookie: `${anotherVisitor.cookie}; ${a.authCookie}` },
  );
  assert.equal(sameAccount.status, 429);
  const b = await signedInAccount();
  const otherAccount = await b.request("/api/uploads", "POST", {
    title: "Other account",
    size: 44,
  });
  assert.equal(otherAccount.status, 201, await otherAccount.clone().text());
  assert.equal((await a.request(`/api/uploads/${accepted[0].id}`, "DELETE")).status, 200);
  const replacement = await a.request("/api/uploads", "POST", {
    title: "Replacement after cancellation",
    size: 44,
  });
  assert.equal(replacement.status, 201, await replacement.clone().text());
  const quota = await db
    .prepare("SELECT COUNT(*) AS count FROM uploads WHERE owner_id=? AND substr(created_at,1,7)=? AND state NOT IN ('aborted','rejected')")
    .bind(a.id, month)
    .first();
  assert.equal(quota.count, 100);
  const page = await (await a.request("/api/space/episodes")).json();
  assert.equal(page.usedThisMonth, 100);
  assert.equal(page.monthlyLimit, 100);
});
test("parallel upload starts cannot exceed an account's storage cap", async () => {
  const a = await signedInAccount();
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO uploads(id,owner_id,upload_id,object_key,title,size,created_at,state) VALUES(?,?,?,?,?,?,?,?)")
    .bind(id, a.id, "old", `episodes/${id}/original`, "Old", 20 * 1024 ** 3 - 100, "2020-01-01T00:00:00.000Z", "complete").run();
  const results = await Promise.all([0, 1].map(() =>
    a.request("/api/uploads", "POST", { title: "New", size: 80 })));
  assert.equal(results.filter((result) => result.status === 201).length, 1);
  assert.equal(results.filter((result) => result.status === 429).length, 1);
  const accepted = await results.find((result) => result.status === 201).json();
  assert.equal((await a.request(`/api/uploads/${accepted.id}`, "DELETE")).status, 200);
  await db.prepare("UPDATE uploads SET state='deleted' WHERE id=?").bind(id).run();
});
test("personal Space isolates accounts and deletion removes private data without refunding a completed upload", async () => {
  const guest = await visitor(false);
  assert.equal((await guest.request("/api/space/episodes")).status, 401);
  const a = await signedInAccount(), b = await signedInAccount();
  const id = crypto.randomUUID();
  await seed(id, a.id);
  await db.prepare("INSERT INTO uploads(id,owner_id,upload_id,object_key,title,size,created_at,state) VALUES(?,?,?,?,?,?,?,?)")
    .bind(id, a.id, "uploaded", `episodes/${id}/original`, "Episode", 10, new Date().toISOString(), "complete")
    .run();
  await db.prepare("INSERT INTO checkpoints(owner_id,episode_id,value) VALUES(?,?,?)")
    .bind(a.id, id, JSON.stringify({ positionMs: 1, revision: 0 })).run();
  const listed = await a.request("/api/space/episodes");
  assert.equal(listed.status, 200);
  const page = await listed.json();
  assert.ok(page.episodes.some((episode) => episode.id === id));
  assert.equal(page.usedThisMonth, 1);
  assert.equal(page.monthlyLimit, 100);
  const otherPage = await (await b.request("/api/space/episodes")).json();
  assert.ok(!otherPage.episodes.some((episode) => episode.id === id));
  assert.equal((await b.request(`/api/space/episodes/${id}`, "DELETE")).status, 404);
  assert.equal((await a.request(`/api/space/episodes/${id}`, "DELETE")).status, 200);
  assert.equal((await a.request(`/api/episodes/${id}`)).status, 404);
  assert.equal(await bucket.head(`episodes/${id}/original`), null);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM checkpoints WHERE episode_id=?").bind(id).first()).count, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE key LIKE ?").bind(`episodes/${id}/%`).first()).count, 0);
  assert.equal((await a.request("/api/space/episodes").then((response) => response.json())).usedThisMonth, 1);
});
test("question stream, Live ownership and server-reserved quotas use network-only adapter", async () => {
  const a = await visitor(),
    b = await visitor();
  const response = await a.request(
    "/api/episodes/public/question",
    "POST",
    { atMs: 0, revision: 9, history: [{ role: "user", text: "Explain this" }] },
    { accept: "application/x-ndjson" },
  );
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split("\n").map(JSON.parse);
  assert.equal(events.at(-1).type, "result");
  assert.equal(events.at(-1).result.revision, 9);
  const live = await (
    await a.request("/api/episodes/public/live", "POST", {
      sdp: "offer",
      atMs: 0,
    })
  ).json();
  const usage = { sessionId: live.session.id, seconds: 10, finalized: true };
  assert.equal(
    (await a.request("/api/episodes/public/usage", "POST", usage)).status,
    200,
  );
  assert.equal(
    (await b.request("/api/episodes/public/usage", "POST", usage)).status,
    404,
  );
  assert.deepEqual(
    await (await b.request("/api/episodes/public/usage")).json(),
    [],
  );
  const day = new Date().toISOString().slice(0, 10);
  await db
    .prepare(
      "INSERT INTO budgets VALUES(?,30) ON CONFLICT(bucket) DO UPDATE SET used=30",
    )
    .bind(`trial:${day}:live:${a.id}`)
    .run();
  const before = networkCalls.length;
  assert.equal(
    (
      await a.request("/api/episodes/public/live", "POST", {
        sdp: "offer",
        atMs: 0,
      })
    ).status,
    429,
  );
  assert.equal(networkCalls.length, before);
});
test("analysis retries reuse durable transcript/audio, survive temporary media loss and persist evidence", async () => {
  const id = crypto.randomUUID();
  await seed(id, "owner", false, false);
  let transcriptions = 0,
    enrichments = 0,
    segmentReads = 0,
    fail = true;
  const provider = {
    async transcribeAudio() {
      transcriptions++;
      return [
        { id: "p1", startMs: 100, endMs: 900, text: "Hello", speaker: "s1" },
      ];
    },
    async enrichAudio(_bytes, _passages, persist) {
      enrichments++;
      await persist(JSON.stringify({ raw: "evidence" }));
      if (fail) throw Error("Temporary provider failure");
      return {
        summary: "Summary",
        hostStyle: "Calm",
        speakers: [],
        groups: [{ firstId: "p1", lastId: "p1" }],
      };
    },
  };
  const media = {
    async open() {
      return {
        manifest: {
          durationMs: 1000,
          mimeType: "audio/wav",
          pauses: [],
          plan: [{ offsetMs: 0, durationMs: 1000 }],
        },
        async segment() {
          segmentReads++;
          return new TextEncoder().encode("encoded");
        },
        async cover() {},
        async close() {},
      };
    },
  };
  const steps = { do: (_name, fn) => fn() };
  await assert.rejects(
    analyzeEpisode({ DB: db, AUDIO: bucket }, id, steps, media, provider),
  );
  assert.equal(
    JSON.parse(
      (
        await db
          .prepare("SELECT metadata FROM episodes WHERE id=?")
          .bind(id)
          .first()
      ).metadata,
    ).status,
    "failed",
  );
  fail = false;
  await analyzeEpisode(
    { DB: db, AUDIO: bucket },
    id,
    steps,
    {
      // Every segment is already in R2, so the retry never needs a container.
      open() {
        throw Error("Source container is gone");
      },
    },
    provider,
  );
  assert.equal(transcriptions, 1);
  assert.equal(segmentReads, 1);
  assert.equal(enrichments, 2);
  const store = new CloudStore(db, bucket),
    episode = await store.episode(await store.row(id));
  assert.equal(episode.status, "ready");
  assert.equal(episode.analysis.passages[0].text, "Hello");
  assert.equal(
    (
      await db
        .prepare("SELECT DISTINCT key FROM artifacts WHERE key>=? AND key<?")
        .bind(
          `episodes/${id}/analysis-v1/evidence-`,
          `episodes/${id}/analysis-v1/evidence-\uffff`,
        )
        .all()
    ).results.length,
    2,
  );
});
test("segments analyze concurrently up to ANALYSIS_CONCURRENCY and assemble in timeline order", async () => {
  const id = crypto.randomUUID();
  await seed(id, "owner", false, false);
  const plan = Array.from({ length: 5 }, (_, i) => ({ offsetMs: i * 1000, durationMs: 1000 }));
  let active = 0,
    peak = 0;
  const provider = {
    async transcribeAudio(_bytes, offsetMs) {
      active++;
      peak = Math.max(peak, active);
      // Later segments finish first.
      await new Promise((resolve) => setTimeout(resolve, 40 - offsetMs / 200));
      active--;
      return [
        { id: `p-${offsetMs}`, startMs: offsetMs + 100, endMs: offsetMs + 900, text: `S${offsetMs / 1000}`, speaker: "s1" },
      ];
    },
    async enrichAudio(_bytes, passages) {
      return {
        summary: "",
        hostStyle: "",
        speakers: [],
        groups: [{ firstId: passages[0].id, lastId: passages[0].id }],
      };
    },
  };
  const media = {
    async open() {
      return {
        manifest: { durationMs: 5000, mimeType: "audio/mpeg", pauses: [], plan },
        segment: async () => new TextEncoder().encode("encoded"),
        cover: async () => undefined,
        close: async () => {},
      };
    },
  };
  const store = new CloudStore(db, bucket);
  const progress = [];
  const steps = {
    async do(_name, fn) {
      const result = await fn();
      progress.push(JSON.parse((await store.row(id)).metadata).progress);
      return result;
    },
  };
  await analyzeEpisode(
    { DB: db, AUDIO: bucket, ANALYSIS_CONCURRENCY: "2" },
    id,
    steps,
    media,
    provider,
  );
  assert.equal(peak, 2);
  const episode = await store.episode(await store.row(id));
  assert.equal(episode.status, "ready");
  assert.deepEqual(episode.analysis.passages.map((p) => p.text), ["S0", "S1", "S2", "S3", "S4"]);
  assert.deepEqual(progress, [...progress].sort((a, b) => a - b));
});
test("actual FFmpeg service probes, segments, rejects invalid media and reports an unprepared source", async () => {
  const root = await mkdtemp(join(tmpdir(), "aside-container-test-"));
  const app = mediaApp(root),
    id = crypto.randomUUID();
  try {
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
    const prepare = await app.inject({
      method: "POST",
      url: `/prepare?id=${id}`,
      headers: { "content-type": "application/octet-stream" },
      payload: wav,
    });
    assert.equal(prepare.statusCode, 200, prepare.body);
    assert.equal(prepare.json().durationMs, 100);
    const chunk = await app.inject(`/chunk?id=${id}&index=0`);
    assert.equal(chunk.statusCode, 200);
    assert.ok(chunk.rawPayload.length > 100);
    assert.equal((await app.inject(`/chunk?id=${id}&index=1`)).statusCode, 400);
    await app.inject({ method: "DELETE", url: `/source?id=${id}` });
    assert.equal((await app.inject(`/chunk?id=${id}&index=0`)).statusCode, 409);
    const bad = await app.inject({
      method: "POST",
      url: `/prepare?id=${id}`,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("bad"),
    });
    assert.equal(bad.statusCode, 422);
    assert.match(bad.json().error, /音轨/);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("actual FFmpeg service cuts contiguous segments at pauses from one speech track", async () => {
  const root = await mkdtemp(join(tmpdir(), "aside-segment-test-"));
  const app = mediaApp(root),
    id = crypto.randomUUID();
  try {
    const source = join(root, "talk.wav");
    // 500 s of tone with a pause from 238 s to 241 s, around the first 240 s boundary.
    execFileSync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi",
      "-i", "aevalsrc=if(between(t\\,238\\,241)\\,0\\,0.3*sin(440*2*PI*t)):s=8000:d=500",
      "-ac", "1", "-c:a", "pcm_s16le", source,
    ]);
    const prepare = await app.inject({
      method: "POST",
      url: `/prepare?id=${id}`,
      headers: { "content-type": "application/octet-stream" },
      payload: await readFile(source),
    });
    assert.equal(prepare.statusCode, 200, prepare.body);
    const { plan, durationMs } = prepare.json();
    assert.equal(plan.length, 3, JSON.stringify(plan));
    assert.equal(plan[0].offsetMs, 0);
    assert.ok(Math.abs(plan[1].offsetMs - 239500) < 100, JSON.stringify(plan));
    for (let i = 1; i < plan.length; i++)
      assert.ok(
        Math.abs(plan[i].offsetMs - (plan[i - 1].offsetMs + plan[i - 1].durationMs)) <= 2,
        JSON.stringify(plan),
      );
    assert.ok(Math.abs(plan.at(-1).offsetMs + plan.at(-1).durationMs - durationMs) < 100);
    for (let i = 0; i < plan.length; i++) {
      const chunk = await app.inject(`/chunk?id=${id}&index=${i}`);
      assert.equal(chunk.statusCode, 200);
      assert.ok(chunk.rawPayload.length > 1000);
    }
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("real media probe accepts exactly five hours and rejects one second more before analysis", async () => {
  const root = await mkdtemp(join(tmpdir(), "aside-five-hour-test-"));
  const app = mediaApp(root);
  const makeWav = (seconds) => {
    const wav = Buffer.alloc(44 + seconds, 128);
    wav.write("RIFF");
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(1, 24);
    wav.writeUInt32LE(1, 28);
    wav.writeUInt16LE(1, 32);
    wav.writeUInt16LE(8, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(seconds, 40);
    return wav;
  };
  try {
    // The limit itself is checked on the probe; encoding five hours would dominate the suite.
    const atLimit = join(root, "at-limit.wav");
    await writeFile(atLimit, makeWav(5 * 3600));
    assert.equal((await admitAudio(atLimit)).durationMs, 5 * 3600000);
    const over = await app.inject({
      method: "POST",
      url: `/prepare?id=${crypto.randomUUID()}`,
      headers: { "content-type": "application/octet-stream" },
      payload: makeWav(5 * 3600 + 1),
    });
    assert.equal(over.statusCode, 422, over.body);
    assert.match(over.json().error, /5 小时/);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("actual FFmpeg service extracts embedded artwork only when the file has one", async () => {
  const root = await mkdtemp(join(tmpdir(), "aside-cover-test-"));
  const app = mediaApp(root),
    withCover = crypto.randomUUID(),
    plain = crypto.randomUUID();
  const mp3 = (name, picture) => {
    const path = join(root, name);
    execFileSync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-t", "1", "-i", "anullsrc=r=24000:cl=mono",
      ...(picture
        ? ["-f", "lavfi", "-i", "color=c=red:s=1200x800:d=1", "-map", "0:a", "-map", "1:v", "-frames:v", "1", "-c:v", "png", "-disposition:v", "attached_pic"]
        : []),
      "-c:a", "libmp3lame", "-id3v2_version", "3", path,
    ]);
    return readFile(path);
  };
  const prepare = async (id, payload) =>
    app.inject({
      method: "POST",
      url: `/prepare?id=${id}`,
      headers: { "content-type": "application/octet-stream" },
      payload,
    });
  try {
    const first = await prepare(withCover, await mp3("cover.mp3", true));
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().cover, true);
    const cover = await app.inject(`/cover?id=${withCover}`);
    assert.equal(cover.statusCode, 200);
    assert.equal(cover.headers["content-type"], "image/jpeg");
    assert.deepEqual([...cover.rawPayload.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    await app.inject({ method: "DELETE", url: `/source?id=${withCover}` });
    assert.equal((await app.inject(`/cover?id=${withCover}`)).statusCode, 409);
    const second = await prepare(plain, await mp3("plain.mp3", false));
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().cover, false);
    assert.equal((await app.inject(`/cover?id=${plain}`)).statusCode, 404);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("analysis stores extracted artwork and never fails over a lost cover", async () => {
  const provider = {
    transcribeAudio: async () => [
      { id: "p1", startMs: 100, endMs: 900, text: "Hello", speaker: "s1" },
    ],
    enrichAudio: async () => ({
      summary: "Summary",
      hostStyle: "Calm",
      speakers: [],
      groups: [{ firstId: "p1", lastId: "p1" }],
    }),
  };
  const media = (cover) => ({
    open: async () => ({
      manifest: {
        durationMs: 1000,
        mimeType: "audio/mpeg",
        cover: true,
        pauses: [],
        plan: [{ offsetMs: 0, durationMs: 1000 }],
      },
      segment: async () => new TextEncoder().encode("encoded"),
      cover,
      close: async () => {},
    }),
  });
  const steps = { do: (_name, fn) => fn() };
  const store = new CloudStore(db, bucket);
  const kept = crypto.randomUUID();
  await seed(kept, "owner", false, false);
  await analyzeEpisode(
    { DB: db, AUDIO: bucket },
    kept,
    steps,
    media(async () => new TextEncoder().encode("jpeg")),
    provider,
  );
  assert.equal((await store.episode(await store.row(kept))).cover, true);
  assert.equal(await (await bucket.get(`episodes/${kept}/cover.jpg`)).text(), "jpeg");
  const lost = crypto.randomUUID();
  await seed(lost, "owner", false, false);
  await analyzeEpisode(
    { DB: db, AUDIO: bucket },
    lost,
    steps,
    media(async () => {
      throw Error("Source container is gone");
    }),
    provider,
  );
  const episode = await store.episode(await store.row(lost));
  assert.equal(episode.status, "ready");
  assert.equal(episode.cover, undefined);
  assert.equal(await bucket.head(`episodes/${lost}/cover.jpg`), null);
});

test("production Workflow orchestrates R2, model adapters, D1 and container binding", async () => {
  const id = crypto.randomUUID();
  const listener = await visitor();
  await seed(id, listener.id, false, false);
  const bindings = await mf.getBindings();
  const instance = await bindings.PROD_ANALYSIS.create({
    id,
    params: { episodeId: id },
  });
  for (let i = 0; i < 100; i++) {
    const state = await instance.status();
    if (["complete", "errored"].includes(state.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const state = await instance.status();
  assert.equal(state.status, "complete", JSON.stringify(state));
  const store = new CloudStore(db, bucket),
    episode = await store.episode(await store.row(id));
  assert.equal(episode.status, "ready");
  assert.equal(episode.analysis.passages[0].text, "A sentence");
  assert.equal(episode.cover, true);
  const cover = await listener.request(`/api/episodes/${id}/cover`);
  assert.equal(cover.status, 200);
  assert.equal(cover.headers.get("content-type"), "image/jpeg");
  assert.equal(await cover.text(), "jpeg bytes");
  const plain = crypto.randomUUID();
  await seed(plain, listener.id);
  assert.equal((await listener.request(`/api/episodes/${plain}/cover`)).status, 404);
});
test("admission failure blocks an upload and removes its original before any model request", async () => {
  const id = crypto.randomUUID();
  await seed(id, "admission-owner", false, false);
  await bucket.put(`episodes/${id}/original`, "invalid-long");
  await db.prepare("INSERT INTO uploads(id,owner_id,upload_id,object_key,title,size,created_at,state) VALUES(?,?,?,?,?,?,?,?)")
    .bind(id, "admission-owner", "complete", `episodes/${id}/original`, "Too long", 12, new Date().toISOString(), "complete").run();
  const calls = networkCalls.length;
  const bindings = await mf.getBindings();
  const instance = await bindings.PROD_ANALYSIS.create({ id, params: { episodeId: id } });
  await eventually(async () => ["errored", "complete"].includes((await instance.status()).status));
  const episode = await new CloudStore(db, bucket).row(id);
  assert.equal(JSON.parse(episode.metadata).status, "blocked");
  assert.equal(JSON.parse(episode.metadata).error, "单个音频不能超过 5 小时");
  assert.equal(await bucket.head(`episodes/${id}/original`), null);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM uploads WHERE id=?").bind(id).first()).count, 0);
  assert.equal(networkCalls.length, calls);
});

test("repeated upload completion cannot restart failed analysis without a quota reservation", async () => {
  const { startAnalysis } = await import("../../cloudflare/src/uploads.ts");
  let restarts = 0;
  const env = {
    ANALYSIS: {
      async create() {
        throw Error("Already exists");
      },
      async get() {
        return {
          async status() {
            return { status: "errored" };
          },
          async restart() {
            restarts++;
          },
        };
      },
    },
    DB: {
      prepare() {
        return {
          bind() {
            return { async run() {} };
          },
        };
      },
    },
  };
  await assert.rejects(
    startAnalysis(env, "episode"),
    (error) => error.status === 409,
  );
  await assert.rejects(
    startAnalysis(env, "episode", async () => {
      throw Error("No quota");
    }),
  );
  assert.equal(restarts, 0);
  await startAnalysis(env, "episode", async () => {});
  assert.equal(restarts, 1);
});

async function eventually(check) {
  for (let i = 0; i < 80; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("Timed out waiting for durable state");
}
test("trial proof is mandatory, bound to visitor/IP/hostname/action, and tokens cannot replay", async () => {
  const a = await visitor(false);
  const question = {
    atMs: 0,
    revision: 1,
    history: [{ role: "user", text: "Explain" }],
  };
  let calls = networkCalls.length;
  const missing = await a.request(
    "/api/episodes/public/question",
    "POST",
    question,
  );
  assert.equal(missing.status, 403);
  assert.equal((await missing.json()).code, "trial_verification_required");
  assert.equal(networkCalls.length, calls);
  assert.equal((await a.request("/api/episodes/public/audio")).status, 200);
  for (const override of [
    { hostname: "evil.test" },
    { action: "other" },
    { cdata: "other" },
    { success: false },
  ]) {
    const result = await a.request("/api/trial", "POST", {
      token: JSON.stringify({
        cdata: a.id,
        ...override,
        nonce: crypto.randomUUID(),
      }),
    });
    assert.equal(result.status, 403);
  }
  const token = JSON.stringify({ cdata: a.id, nonce: crypto.randomUUID() });
  assert.equal((await a.request("/api/trial", "POST", { token })).status, 200);
  const proof = await db.prepare("SELECT expires FROM trial_proofs WHERE owner=?").bind(a.id).first();
  assert.ok(proof.expires > Date.now() + 5 * 60 * 60 * 1000);
  assert.equal((await a.request("/api/trial", "POST", { token })).status, 403);
  calls = networkCalls.length;
  assert.equal(
    (
      await a.request("/api/episodes/public/question", "POST", question, {
        "cf-connecting-ip": "203.0.113.10",
      })
    ).status,
    403,
  );
  assert.equal(networkCalls.length, calls);
  await db
    .prepare("UPDATE trial_proofs SET expires=0 WHERE owner=?")
    .bind(a.id)
    .run();
  assert.equal(
    (await a.request("/api/episodes/public/question", "POST", question)).status,
    403,
  );
});
test("signed-in accounts skip Turnstile but retain paid question quotas", async () => {
  const account = await signedInAccount();
  const trial = await account.request("/api/trial");
  assert.equal(trial.status, 200);
  assert.equal((await trial.json()).verified, true);
  const verifications = networkCalls.filter((path) => path.endsWith("/siteverify")).length;
  const id = `account-trial-${crypto.randomUUID()}`;
  await seed(id, account.id);
  const payload = {
    atMs: 0,
    revision: 1,
    history: [{ role: "user", text: "Explain" }],
  };
  for (let i = 0; i < 5; i++) {
    const response = await account.request(`/api/episodes/${id}/question`, "POST", payload);
    assert.equal(response.status, 200, await response.text());
  }
  assert.equal((await account.request(`/api/episodes/${id}/question`, "POST", payload)).status, 429);
  assert.equal(networkCalls.filter((path) => path.endsWith("/siteverify")).length, verifications);
});
test("allowlisted IP bypasses exhausted daily pools without consuming them", async () => {
  const bindings = await mf.getBindings();
  const a = await visitor();
  const day = new Date().toISOString().slice(0, 10);
  const snapshots = await db.prepare("SELECT bucket,used FROM budgets WHERE bucket LIKE 'trial:%'").all();
  const request = new Request(origin, { headers: { "cf-connecting-ip": testerIp } });
  try {
    for (const kind of ["live", "question", "transcribe"]) {
      for (const [scope, limit] of [[a.id, 5], [`ip:${testerIpHash}`, kind === "live" ? 10 : 20], ["global", kind === "live" ? 10 : 100]]) {
        await db.prepare("INSERT INTO budgets VALUES(?,?) ON CONFLICT(bucket) DO UPDATE SET used=excluded.used").bind(`trial:${day}:${kind}:${scope}`, limit).run();
      }
    }
    const before = (await db.prepare("SELECT bucket,used FROM budgets ORDER BY bucket").all()).results;
    for (const kind of ["live", "question", "transcribe"]) {
      await budget(bindings, a.id, kind, request);
      await budget(bindings, a.id, kind, request);
      await assert.rejects(budget(bindings, a.id, kind, new Request(origin, { headers: { "cf-connecting-ip": "192.0.2.11" } })), /今日体验额度已用完/);
      await assert.rejects(budget(bindings, a.id, kind), /今日体验额度已用完/);
    }
    assert.deepEqual((await db.prepare("SELECT bucket,used FROM budgets ORDER BY bucket").all()).results, before);
    assert.equal((await (await a.request("/api/trial", "GET", undefined, { "cf-connecting-ip": testerIp })).json()).dailyLimitExempt, true);
    assert.equal((await (await a.request("/api/trial")).json()).dailyLimitExempt, false);

    const headers = { "cf-connecting-ip": testerIp };
    const payload = { atMs: 0, revision: 1, history: [{ role: "user", text: "Explain" }] };
    // An exemption does not grant guest verification.
    assert.equal((await a.request("/api/episodes/public/question", "POST", payload, headers)).status, 403);
    const verified = await a.request("/api/trial", "POST", { token: JSON.stringify({ cdata: a.id, nonce: crypto.randomUUID() }) }, headers);
    assert.equal(verified.status, 200);
    for (let i = 0; i < 6; i++) {
      const answer = await a.request("/api/episodes/public/question", "POST", payload, headers);
      assert.equal(answer.status, 200, await answer.text());
    }
    await db.prepare("UPDATE trial_control SET enabled=0 WHERE id=1").run();
    assert.equal((await a.request("/api/episodes/public/question", "POST", payload, headers)).status, 503);
    await db.prepare("UPDATE trial_control SET enabled=1 WHERE id=1").run();
    // Existing per-minute guard still applies to testers.
    await db.prepare("INSERT INTO budgets VALUES(?,12) ON CONFLICT(bucket) DO UPDATE SET used=12").bind(`burst:${Math.floor(Date.now() / 60000)}:${a.id}`).run();
    const limited = await a.request("/api/episodes/public/question", "POST", payload, headers);
    assert.equal(limited.status, 429);
    assert.match((await limited.json()).error, /一分钟/);
  } finally {
    await db.prepare("UPDATE trial_control SET enabled=1 WHERE id=1").run();
    await db.prepare("DELETE FROM budgets WHERE bucket LIKE 'trial:%'").run();
    for (const row of snapshots.results)
      await db.prepare("INSERT INTO budgets VALUES(?,?)").bind(row.bucket, row.used).run();
  }
});

test("five question reservations are enforced before providers; kill switch preserves playback", async () => {
  const a = await visitor();
  const payload = {
    atMs: 0,
    revision: 1,
    history: [{ role: "user", text: "Explain" }],
  };
  for (let i = 0; i < 5; i++) {
    const response = await a.request(
      "/api/episodes/public/question",
      "POST",
      payload,
    );
    assert.equal(response.status, 200, await response.text());
  }
  const before = networkCalls.length;
  assert.equal(
    (await a.request("/api/episodes/public/question", "POST", payload)).status,
    429,
  );
  assert.equal(networkCalls.length, before);
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM trial_leases WHERE owner=?")
        .bind(a.id)
        .first()
    ).n,
    0,
  );
  await db.prepare("UPDATE trial_control SET enabled=0 WHERE id=1").run();
  try {
    assert.equal(
      (await a.request("/api/episodes/public/question", "POST", payload))
        .status,
      503,
    );
    assert.equal((await a.request("/api/episodes/public/audio")).status, 200);
    assert.equal(networkCalls.length, before);
  } finally {
    await db.prepare("UPDATE trial_control SET enabled=1 WHERE id=1").run();
  }
});
test("parallel lease acquisition has one winner and stale releases cannot unlock another request", async () => {
  const { acquire, release } = await import("../../cloudflare/src/trial.ts");
  const env = { DB: db, AUDIO: bucket };
  const owner = crypto.randomUUID();
  const results = await Promise.allSettled(
    Array.from({ length: 15 }, () => acquire(env, owner, "operation")),
  );
  const wins = results.filter((x) => x.status === "fulfilled");
  assert.equal(wins.length, 1);
  await release(env, owner, "operation", "stale");
  await assert.rejects(acquire(env, owner, "operation"));
  // A cold voice connection and its first transcription are legitimate parallel work.
  const live = await acquire(env, owner, "live");
  await release(env, owner, "operation", wins[0].value);
  const next = await acquire(env, owner, "operation");
  await release(env, owner, "operation", wins[0].value);
  await assert.rejects(acquire(env, owner, "operation"));
  await release(env, owner, "operation", next);
  await release(env, owner, "live", live);
});
test("voice deadline sends server-side session.close without browser cooperation", async () => {
  const a = await visitor();
  const response = await a.request("/api/episodes/public/live", "POST", {
    sdp: "offer",
    atMs: 0,
  });
  assert.equal(response.status, 200, await response.clone().text());
  const session = (await response.json()).session.id;
  const before = controlEvents.length;
  const bindings = await mf.getBindings();
  await bindings.LIVE.get(bindings.LIVE.idFromName(a.id)).expire();
  await eventually(
    async () =>
      !(await db
        .prepare("SELECT token FROM trial_leases WHERE owner=? AND kind='live'")
        .bind(a.id)
        .first()),
  );
  assert.ok(
    controlEvents.slice(before).some((x) => x.type === "session.close"),
  );
  assert.equal(
    (
      await db
        .prepare("SELECT finalized FROM voice_usage WHERE session_id=?")
        .bind(session)
        .first()
    ).finalized,
    1,
  );
});
test("unconfirmed voice close retains lease and trips breaker despite browser finalization", async () => {
  const a = await visitor();
  const response = await a.request("/api/episodes/public/live", "POST", {
    sdp: "offer",
    atMs: 0,
  });
  assert.equal(response.status, 200, await response.clone().text());
  const session = (await response.json()).session.id;
  const bindings = await mf.getBindings(),
    supervisor = bindings.LIVE.get(bindings.LIVE.idFromName(a.id));
  acknowledgeClose = false;
  try {
    assert.equal(
      (
        await a.request("/api/episodes/public/usage", "POST", {
          sessionId: session,
          seconds: 9999,
          finalized: true,
        })
      ).status,
      200,
    );
    await supervisor.expire();
    assert.ok(
      await db
        .prepare("SELECT owner FROM trial_breakers WHERE owner=?")
        .bind(a.id)
        .first(),
    );
    assert.ok(
      await db
        .prepare("SELECT token FROM trial_leases WHERE owner=? AND kind='live'")
        .bind(a.id)
        .first(),
    );
    const usage = await db
      .prepare("SELECT finalized,seconds FROM voice_usage WHERE session_id=?")
      .bind(session)
      .first();
    assert.equal(usage.finalized, 0);
    assert.equal(usage.seconds, 120);
    const before = networkCalls.length;
    assert.equal(
      (
        await a.request("/api/episodes/public/live", "POST", {
          sdp: "offer",
          atMs: 0,
        })
      ).status,
      503,
    );
    assert.equal(networkCalls.length, before);
  } finally {
    acknowledgeClose = true;
    await supervisor.expire();
    await eventually(
      async () =>
        !(await db
          .prepare("SELECT owner FROM trial_breakers WHERE owner=?")
          .bind(a.id)
          .first()),
    );
  }
});
test("a session the supplier has dropped stops pausing everyone", async () => {
  const a = await visitor();
  const created = await a.request("/api/episodes/public/live", "POST", {
    sdp: "offer",
    atMs: 0,
  });
  assert.equal(created.status, 200, await created.clone().text());
  const session = (await created.json()).session.id;
  const bindings = await mf.getBindings(),
    supervisor = bindings.LIVE.get(bindings.LIVE.idFromName(a.id));
  attachGone = true;
  try {
    await supervisor.expire();
    // The supplier said the session is over, so no close frame can ever
    // arrive: the breaker and the lease must not outlive it.
    assert.ok(
      !(await db
        .prepare("SELECT owner FROM trial_breakers WHERE owner=?")
        .bind(a.id)
        .first()),
      "the breaker must be released",
    );
    assert.ok(
      !(await db
        .prepare("SELECT token FROM trial_leases WHERE owner=? AND kind='live'")
        .bind(a.id)
        .first()),
      "the live lease must be released",
    );
    const usage = await db
      .prepare("SELECT finalized FROM voice_usage WHERE session_id=?")
      .bind(session)
      .first();
    assert.equal(usage.finalized, 1);
    // Everyone else can talk to the model again.
    assert.equal((await (await a.request("/api/trial")).json()).enabled, true);
  } finally {
    attachGone = false;
  }
});
test("an unconfirmable session inside the grace window keeps the breaker", async () => {
  const a = await visitor();
  const created = await a.request("/api/episodes/public/live", "POST", {
    sdp: "offer",
    atMs: 0,
  });
  assert.equal(created.status, 200, await created.clone().text());
  const bindings = await mf.getBindings(),
    supervisor = bindings.LIVE.get(bindings.LIVE.idFromName(a.id));
  attachBroken = true;
  try {
    await supervisor.detach();
    await supervisor.expireAt(Date.now() - 1000);
    assert.ok(
      await db
        .prepare("SELECT owner FROM trial_breakers WHERE owner=?")
        .bind(a.id)
        .first(),
      "a transient failure still pauses new AI calls",
    );
  } finally {
    // The breaker is global: close the session so the rest of the suite is
    // not paused behind it.
    attachBroken = false;
    await supervisor.expire();
    await eventually(
      async () =>
        !(await db
          .prepare("SELECT owner FROM trial_breakers WHERE owner=?")
          .bind(a.id)
          .first()),
    );
  }
});
test("a session that cannot be confirmed within the grace window is released", async () => {
  const a = await visitor();
  const created = await a.request("/api/episodes/public/live", "POST", {
    sdp: "offer",
    atMs: 0,
  });
  assert.equal(created.status, 200, await created.clone().text());
  const session = (await created.json()).session.id;
  const bindings = await mf.getBindings(),
    supervisor = bindings.LIVE.get(bindings.LIVE.idFromName(a.id));
  attachBroken = true;
  try {
    await supervisor.detach();
    await supervisor.expireAt(Date.now() - 60 * 60 * 1000);
    // One lost close acknowledgement must not pause every listener for good.
    assert.ok(
      !(await db
        .prepare("SELECT owner FROM trial_breakers WHERE owner=?")
        .bind(a.id)
        .first()),
      "the breaker must not outlive the grace window",
    );
    assert.ok(
      !(await db
        .prepare("SELECT token FROM trial_leases WHERE owner=? AND kind='live'")
        .bind(a.id)
        .first()),
      "the live lease must be released",
    );
    // The unconfirmed usage stays visible for an operator instead of being
    // passed off as supplier-confirmed.
    const usage = await db
      .prepare("SELECT finalized FROM voice_usage WHERE session_id=?")
      .bind(session)
      .first();
    assert.equal(usage.finalized, 0);
    assert.equal((await (await a.request("/api/trial")).json()).enabled, true);
  } finally {
    attachBroken = false;
  }
});
test("an unconfirmed creation stops pausing everyone after the grace window", async () => {
  const a = await visitor();
  createUnknown = true;
  try {
    const created = await a.request("/api/episodes/public/live", "POST", {
      sdp: "offer",
      atMs: 0,
    });
    assert.ok(created.status >= 400, "the ambiguous failure reaches the caller");
  } finally {
    createUnknown = false;
  }
  const bindings = await mf.getBindings(),
    supervisor = bindings.LIVE.get(bindings.LIVE.idFromName(a.id));
  await supervisor.expireAt(Date.now() - 60 * 60 * 1000);
  // No session id means no close can ever be confirmed, so the global pause
  // has to end on its own.
  assert.ok(
    !(await db
      .prepare("SELECT owner FROM trial_breakers WHERE owner=?")
      .bind(a.id)
      .first()),
    "the breaker must not outlive the grace window",
  );
  // The lease is the durable trace and keeps this visitor from opening a
  // second session while the first one's fate is unknown.
  assert.ok(
    await db
      .prepare("SELECT token FROM trial_leases WHERE owner=? AND kind='live'")
      .bind(a.id)
      .first(),
    "the unconfirmed lease stays for an operator",
  );
  assert.equal((await (await a.request("/api/trial")).json()).enabled, true);
});
test("oversized history and malformed/long WAV are rejected before any model call", async () => {
  const { validateWav } = await import("../../cloudflare/src/trial.ts");
  const wav = (seconds) => {
    const data = Buffer.alloc(44 + 16000 * 2 * seconds);
    data.write("RIFF");
    data.writeUInt32LE(data.length - 8, 4);
    data.write("WAVEfmt ", 8);
    data.writeUInt32LE(16, 16);
    data.writeUInt16LE(1, 20);
    data.writeUInt16LE(1, 22);
    data.writeUInt32LE(16000, 24);
    data.writeUInt32LE(32000, 28);
    data.writeUInt16LE(2, 32);
    data.writeUInt16LE(16, 34);
    data.write("data", 36);
    data.writeUInt32LE(data.length - 44, 40);
    return data;
  };
  validateWav(wav(30));
  assert.throws(() => validateWav(wav(31)));
  const forged = wav(31);
  forged.writeUInt32LE(320000, 28);
  assert.throws(() => validateWav(forged));
  const a = await visitor(),
    before = networkCalls.length;
  assert.equal(
    (
      await a.request("/api/episodes/public/question", "POST", {
        atMs: 0,
        revision: 1,
        history: [{ role: "user", text: "x".repeat(2001) }],
      })
    ).status,
    413,
  );
  const body = new FormData();
  body.append(
    "audio",
    new Blob([wav(31)], { type: "audio/wav" }),
    "question.wav",
  );
  const encoded = new Request(
    origin + "/api/episodes/public/transcribe-question",
    { method: "POST", body },
  );
  const rejected = await mf.dispatchFetch(encoded.url, {
    method: "POST",
    headers: {
      cookie: a.cookie,
      origin,
      "content-type": encoded.headers.get("content-type"),
    },
    body: await encoded.arrayBuffer(),
  });
  assert.equal(rejected.status, 413, await rejected.text());
  assert.equal(networkCalls.length, before);
});

test("definitively rejected Live request consumes quota but releases concurrency without global breaker", async () => {
  const a = await visitor();
  rejectLive = true;
  try {
    assert.equal(
      (
        await a.request("/api/episodes/public/live", "POST", {
          sdp: "invalid",
          atMs: 0,
        })
      ).status,
      503,
    );
    assert.equal(
      await db
        .prepare("SELECT token FROM trial_leases WHERE owner=?")
        .bind(a.id)
        .first(),
      null,
    );
    assert.equal(
      await db
        .prepare("SELECT owner FROM trial_breakers WHERE owner=?")
        .bind(a.id)
        .first(),
      null,
    );
    const day = new Date().toISOString().slice(0, 10);
    assert.equal(
      (
        await db
          .prepare("SELECT used FROM budgets WHERE bucket=?")
          .bind(`trial:${day}:live:${a.id}`)
          .first()
      ).used,
      1,
    );
  } finally {
    rejectLive = false;
  }
});

test("D1 stores large Unicode artifacts atomically and keeps structured data out of R2", async () => {
  const records = new CloudStore(db, bucket).records;
  const key = "large-artifact",
    value = { transcript: "你😀".repeat(400000) };
  await records.put(key, value);
  assert.deepEqual(await records.get(key), value);
  assert.ok(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM artifacts WHERE key=?")
        .bind(key)
        .first()
    ).n > 1,
  );
  await db
    .prepare(
      "CREATE TRIGGER fail_record BEFORE INSERT ON artifacts WHEN NEW.key='large-artifact' AND NEW.part=1 BEGIN SELECT RAISE(ABORT,'test interrupted write'); END",
    )
    .run();
  try {
    await assert.rejects(
      records.put(key, { transcript: "replacement".repeat(15000) }),
    );
    assert.deepEqual(await records.get(key), value);
  } finally {
    await db.prepare("DROP TRIGGER fail_record").run();
  }
  assert.equal(await bucket.head(key), null);
});

test("question cost is ledgered and only the admin key can read it", async () => {
  const a = await visitor();
  const answered = await a.request("/api/episodes/public/question", "POST", {
    atMs: 0,
    revision: 1,
    history: [{ role: "user", text: "Explain" }],
  });
  assert.equal(answered.status, 200, await answered.clone().text());

  // The write is deferred with waitUntil, so wait for the row rather than assume.
  await eventually(async () => {
    const row = await db
      .prepare("SELECT COUNT(*) AS n FROM question_usage WHERE owner_id=?")
      .bind(a.id)
      .first();
    return row.n === 1;
  });
  const row = await db
    .prepare("SELECT * FROM question_usage WHERE owner_id=?")
    .bind(a.id)
    .first();
  assert.equal(row.tiers, "priority");
  assert.equal(row.rounds, 1);
  assert.equal(row.input_tokens, 1200);
  assert.equal(row.cached_input_tokens, 500);
  assert.equal(row.output_tokens, 400);
  assert.equal(row.reasoning_tokens, 330);
  // Anonymous trial traffic is the split the cost decision turns on.
  assert.equal(row.account_id, null);

  const url = origin + "/api/admin/usage?days=7";
  assert.equal((await mf.dispatchFetch(url)).status, 401);
  assert.equal(
    (
      await mf.dispatchFetch(url, { headers: { "x-admin-key": "wrong-key" } })
    ).status,
    401,
  );
  // A listener's session must never reach the ledger.
  assert.equal((await a.request("/api/admin/usage?days=7")).status, 401);
  assert.equal(
    (
      await mf.dispatchFetch(origin + "/api/admin/usage", {
        method: "POST",
        headers: {
          "x-admin-key": "admin-test-key-at-least-32-characters",
          origin,
        },
      })
    ).status,
    405,
  );

  const report = await mf.dispatchFetch(url, {
    headers: { "x-admin-key": "admin-test-key-at-least-32-characters" },
  });
  assert.equal(report.status, 200, await report.clone().text());
  // An operator CLI is not a listener: no trial identity is handed out.
  assert.equal(report.headers.get("set-cookie"), null);
  assert.equal(report.headers.get("cache-control"), "no-store");
  const data = await report.json();
  assert.equal(data.days, 7);
  assert.ok(data.totals.questions >= 1);
  assert.ok(data.totals.reasoningTokens >= 330);
  // Earlier tests in this file answered questions too, as a listener and as a
  // signed-in account, so the rollups legitimately carry their rows as well.
  assert.deepEqual(
    data.byTier.map((r) => r.tiers),
    ["priority"],
    "every round was served by fast mode, so nothing should report default",
  );
  assert.deepEqual(
    [...data.byAudience.map((r) => r.audience)].sort(),
    ["account", "trial"],
    "the ledger must separate anonymous trial spend from account spend",
  );
  assert.ok(data.topOwners.some((r) => r.owner === a.id));
  assert.equal(data.byDay[0].day, new Date().toISOString().slice(0, 10));
});

test("the daily rollup captures trial counters before cleanup can drop them", async () => {
  const today = new Date().toISOString().slice(0, 10);
  // Three days back: already past the cleanup's two-day horizon, so only the
  // snapshot can still answer for it, yet inside the report window.
  const stale = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  await db.batch([
    db.prepare("DELETE FROM daily_stats"),
    db.prepare("DELETE FROM budgets WHERE bucket LIKE 'trial:%'"),
    // Two visitors asked questions, one of them also used live; plus the
    // per-ip and global variants that must not be counted as visitors.
    db.prepare(
      `INSERT INTO budgets(bucket,used) VALUES
        ('trial:${stale}:question:visitor-a', 3),
        ('trial:${stale}:question:visitor-b', 1),
        ('trial:${stale}:live:visitor-a', 2),
        ('trial:${stale}:question:ip:1.2.3.4', 4),
        ('trial:${stale}:question:global', 4),
        ('trial:${stale}:live:global', 2)`,
    ),
  ]);
  await rollupDailyStats({ DB: db });

  const read = async (day) =>
    Object.fromEntries(
      (
        await db
          .prepare("SELECT metric, value FROM daily_stats WHERE day=?")
          .bind(day)
          .all()
      ).results.map((r) => [r.metric, r.value]),
    );
  const captured = await read(stale);
  assert.equal(captured.trial_visitors_question, 2, "per-ip and global are not visitors");
  assert.equal(captured.trial_visitors_live, 1);
  assert.equal(captured.trial_actions_question, 4, "the global bucket holds the day total");
  assert.equal(captured.trial_actions_live, 2);

  // Gauges land on today, not on the day the counters belong to.
  const gauges = await read(today);
  assert.equal(typeof gauges.users_total, "number");
  assert.equal(typeof gauges.voice_sessions_total, "number");
  assert.equal(gauges.trial_visitors_question, undefined);

  // Running again on the same tick must not double anything.
  await rollupDailyStats({ DB: db });
  assert.deepEqual(await read(stale), captured);

  // A changed counter is corrected in place rather than appended.
  await db
    .prepare("UPDATE budgets SET used=9 WHERE bucket=?")
    .bind(`trial:${stale}:question:global`)
    .run();
  await rollupDailyStats({ DB: db });
  assert.equal((await read(stale)).trial_actions_question, 9);

  // Once cleanup drops the counters, the snapshot is what remains.
  await db.prepare("DELETE FROM budgets WHERE bucket LIKE 'trial:%'").run();
  await rollupDailyStats({ DB: db });
  assert.equal((await read(stale)).trial_visitors_question, 2);

  const report = await mf.dispatchFetch(origin + "/api/admin/usage?days=90", {
    headers: { "x-admin-key": "admin-test-key-at-least-32-characters" },
  });
  const data = await report.json();
  assert.ok(
    data.daily.some(
      (r) => r.day === stale && r.metric === "trial_visitors_question",
    ),
    "the admin report exposes the snapshots",
  );
});

test("the worker serves indexable pages, a live sitemap and real 404s", async () => {
  await seed("seo-public", "curator", true, true);
  await seed("seo-private", "curator", false, true);

  const home = await mf.dispatchFetch(origin + "/");
  assert.equal(home.status, 200, await home.clone().text());
  assert.equal(home.headers.get("content-type"), "text/html; charset=utf-8");
  const homeHtml = await home.text();
  assert.match(homeHtml, /<link rel="canonical" href="https:\/\/asidefm.com\/" \/>/);
  assert.match(homeHtml, /hreflang="zh" href="https:\/\/asidefm\.com\/zh"/);
  assert.match(homeHtml, /<a href="\/episodes\/seo-public">/);
  assert.ok(!homeHtml.includes("seo-private"), "private audio stays out");
  assert.match(homeHtml, /<html lang="en">/);

  const chinese = await mf.dispatchFetch(origin + "/zh");
  const chineseHtml = await chinese.text();
  assert.match(chineseHtml, /<html lang="zh-CN">/);
  assert.match(chineseHtml, /<link rel="canonical" href="https:\/\/asidefm.com\/zh" \/>/);
  assert.ok(chineseHtml.includes("用语音打断播客"));

  const episode = await mf.dispatchFetch(origin + "/episodes/seo-public");
  assert.equal(episode.status, 200, await episode.clone().text());
  const episodeHtml = await episode.text();
  assert.match(episodeHtml, /"@type":"PodcastEpisode"/);
  assert.match(
    episodeHtml,
    /<link rel="canonical" href="https:\/\/asidefm.com\/episodes\/seo-public" \/>/,
  );

  assert.equal(
    (await mf.dispatchFetch(origin + "/episodes/seo-private")).status,
    404,
  );
  assert.equal(
    (await mf.dispatchFetch(origin + "/episodes/does-not-exist")).status,
    404,
  );

  const sitemap = await mf.dispatchFetch(origin + "/sitemap.xml");
  assert.equal(sitemap.status, 200);
  assert.equal(sitemap.headers.get("content-type"), "application/xml");
  const xml = await sitemap.text();
  assert.match(xml, /<loc>https:\/\/asidefm\.com\/zh<\/loc>/);
  assert.match(xml, /<loc>https:\/\/asidefm\.com\/episodes\/seo-public<\/loc>/);
  assert.ok(!xml.includes("seo-private"));

  const space = await mf.dispatchFetch(origin + "/space");
  assert.equal(space.status, 200);
  assert.equal(space.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.ok(!(await space.text()).includes('rel="canonical"'));

  // Manual redirects: the default follows the Location and would leave the
  // isolate for the real network.
  const english = await mf.dispatchFetch(origin + "/en", {
    redirect: "manual",
  });
  assert.equal(english.status, 301);
  assert.equal(english.headers.get("location"), "https://aside.test/");

  // A Chinese recording gets a Chinese page, matching its JSON-LD language.
  const chineseEpisode = {
    id: "seo-zh",
    title: "阿Q正传",
    createdAt: new Date().toISOString(),
    durationMs: 10000,
    status: "ready",
    stage: "ready",
    progress: 1,
    attribution: {
      publisher: "LibriVox",
      author: "鲁迅",
      sourceUrl: "https://archive.org/details/truestoryahq_1612_librivox",
      licenseUrl: "https://librivox.org/pages/public-domain/",
      license: "Public domain",
      language: "zh",
      excerptStartMs: 0,
      excerptEndMs: 1,
    },
  };
  await seed("seo-zh", "curator", true, true);
  await db
    .prepare("UPDATE episodes SET metadata=? WHERE id='seo-zh'")
    .bind(JSON.stringify(chineseEpisode))
    .run();
  const chineseEpisodePage = await mf.dispatchFetch(origin + "/episodes/seo-zh");
  const chineseEpisodeHtml = await chineseEpisodePage.text();
  assert.match(chineseEpisodeHtml, /<html lang="zh-CN">/);
  assert.match(chineseEpisodeHtml, /"inLanguage":"zh-CN"/);
  assert.match(chineseEpisodeHtml, /<h1>阿Q正传<\/h1>/);
});


test("Live sideband pushes multiple decisions on one owner-bound NDJSON stream without question requests", async () => {
  const a = await visitor(), b = await visitor();
  await seed("control-public", "seed", true);
  await a.request("/api/trial", "POST", { token: JSON.stringify({ cdata: a.id, nonce: crypto.randomUUID() }) }, { "cf-connecting-ip": testerIp });
  const { createPlayerConfig } = await import("../../engine/src/player.ts");
  const player = { version: 0, sequence: 0, revision: 1, positionMs: 1000, wasPlaying: true, audibleSource: "podcast", config: createPlayerConfig() };
  const requests = [];
  liveReply = async body => {
    const context = JSON.parse(body.input[0].content); requests.push(context);
    return Response.json({ id: crypto.randomUUID(), output_text: "", output: [{ type: "function_call", call_id: crypto.randomUUID(), name: "control_podcast", arguments: JSON.stringify({ commands: [{ type: "pause" }] }) }] });
  };
  let reader, sessionId;
  try {
    const created = await a.request("/api/episodes/control-public/live", "POST", { sdp: "offer", atMs: 1000, control: { player, debug: true } }, { "cf-connecting-ip": testerIp });
    assert.equal(created.status, 200, await created.clone().text());
    const live = await created.json(); sessionId = live.session.id;
    assert.equal(live.control, true);
    const path = `/api/episodes/control-public/live-control?sessionId=${sessionId}`;
    assert.equal((await b.request(path)).status, 404, "another visitor cannot subscribe to this session");
    const stream = await a.request(path);
    assert.equal(stream.status, 200); assert.match(stream.headers.get("content-type"), /ndjson/);
    reader = stream.body.getReader();
    let buffered = "";
    const next = async type => {
      for (;;) {
        while (buffered.includes("\n")) {
          const at = buffered.indexOf("\n"), line = buffered.slice(0, at); buffered = buffered.slice(at + 1);
          const event = JSON.parse(line); if (event.type === type) return event;
        }
        const { value, done } = await reader.read(); assert.equal(done, false);
        buffered += new TextDecoder().decode(value);
      }
    };
    assert.equal((await next("ready")).sessionId, sessionId);
    assert.equal((await a.request(path)).status, 409, "second subscriber cannot duplicate commands");
    sidebands.get(sessionId).send(JSON.stringify({ type: "session.input_transcript.delta", delta: "Could you lower that a bit?", start_ms: 0, end_ms: 200 }));
    const first = await next("decision");
    assert.equal(first.result.action, "player_control");
    assert.equal(requests.length, 1, "sideband alone invokes the backend model");
    assert.equal(first.player.positionMs, 1000);
    const update = { sessionId, player: { ...player, sequence: 1, revision: 2, wasPlaying: false, audibleSource: "none" }, acknowledgement: { decisionId: first.decisionId, applied: true } };
    assert.equal((await b.request(path, "PUT", update)).status, 404);
    assert.equal((await a.request(path, "PUT", update)).status, 200);
    sidebands.get(sessionId).send(JSON.stringify({ type: "session.delegation.created", delegation: { id: "duplicate", target: "client" } }));
    sidebands.get(sessionId).send(JSON.stringify({ type: "session.input_transcript.delta", delta: "Pause again", start_ms: 2500, end_ms: 2800 }));
    const second = await next("decision");
    assert.notEqual(second.decisionId, first.decisionId);
    assert.equal(second.result.revision, 2);
    assert.equal(requests.length, 2);
    const rows = await db.prepare("SELECT bucket FROM budgets WHERE bucket=?").bind(`trial:${new Date().toISOString().slice(0, 10)}:question:${a.id}`).all();
    assert.equal(rows.results.length, 0, "allowlisted control sessions do not consume public quota per fragment");
    assert.equal(networkCalls.some(p => p.includes("live-control")), false);
  } finally {
    liveReply = undefined;
    await reader?.cancel();
    if (sessionId) await a.request("/api/episodes/control-public/usage", "POST", { sessionId, seconds: 1, finalized: true });
  }
});
