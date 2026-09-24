import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import type { PlayerBackend } from "@aside/player-runtime/ports";
type MobileApi = Required<
  Pick<PlayerBackend, "control" | "updateControl" | "live" | "usage">
> & {
  token: string | null;
  accountId: string | null;
  cancelUpload(): Promise<void>;
  upload(
    file: { uri: string; name: string; mimeType: string; size: number },
    signal: AbortSignal,
    progress: (value: number, phase: "uploading" | "processing") => void,
  ): Promise<unknown>;
  request<T>(path: string, init?: RequestInit): Promise<T>;
  onExpired?: () => void;
  restore(): Promise<void>;
  browserSignIn(provider: "google" | "apple"): Promise<{ id: string } | null>;
};
import type { LiveControlUpdate } from "@aside/engine/contracts";
import { liveSchema } from "@aside/engine/contracts";
import { createPlayerConfig } from "@aside/engine/player";

async function fixture(
  fetcher: typeof fetch,
  storage = new Map<string, string>(),
  native = {
    cancel: async (_id: string) => {},
    start: async (..._args: unknown[]) => {},
    status: async (_id: string) => ({ state: "missing", progress: 0 }),
  },
  browser: (
    url: string,
    redirect: string,
  ) => Promise<{ type: string; url?: string }> = async () => ({
    type: "cancel",
  }),
) {
  const key = `mobileApi_${crypto.randomUUID()}`;
  const global = globalThis as unknown as Record<string, unknown>;
  global[key] = { fetcher, storage, native, browser };
  const modules: Record<string, string> = {
    "react-native": `export const Platform={OS:"android",Version:33}, PermissionsAndroid={PERMISSIONS:{POST_NOTIFICATIONS:"notifications"},request:async()=>"denied"}, NativeModules={AsideUpload:globalThis[${JSON.stringify(key)}].native};`,
    "@react-native-async-storage/async-storage": `const store = globalThis[${JSON.stringify(key)}].storage; export default {getItem:async(key)=>store.get(key)??null,setItem:async(key,value)=>{store.set(key,value)},removeItem:async(key)=>{store.delete(key)}};`,
    "expo-constants":
      'export default {expoConfig:{scheme:"aside",extra:{apiUrl:"https://api.example.com"}}};',
    "expo-secure-store": `const store = globalThis[${JSON.stringify(key)}].storage;
       export const getItemAsync=async(key)=>store.get(key)??null,
         setItemAsync=async(key,value)=>{store.set(key,value)},
         deleteItemAsync=async(key)=>{store.delete(key)};`,
    "expo-file-system": "export class File { exists=false; }",
    "expo-crypto": `import { createHash, randomBytes } from "node:crypto";
       export const CryptoDigestAlgorithm={SHA256:"SHA-256"}, CryptoEncoding={BASE64:"base64"};
       export const getRandomBytes=(n)=>new Uint8Array(randomBytes(n));
       export const digestStringAsync=async(_a,value)=>createHash("sha256").update(value).digest("base64");`,
    "expo-web-browser": `const state = globalThis[${JSON.stringify(key)}];
       export const openAuthSessionAsync=(url,redirect)=>state.browser(url,redirect);`,
    "expo/fetch": `export const fetch = globalThis[${JSON.stringify(key)}].fetcher;`,
  };
  const bundle = await build({
    entryPoints: ["mobile/src/api.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    plugins: [
      {
        name: "os-boundary",
        setup(builder) {
          builder.onResolve(
            {
              filter:
                /^(?:expo(?:-|\/)|react-native$|@react-native-async-storage\/async-storage$)/,
            },
            ({ path }) => ({
              path,
              namespace: "os",
            }),
          );
          builder.onLoad({ filter: /.*/, namespace: "os" }, ({ path }) => ({
            contents: modules[path],
            loader: "js",
          }));
        },
      },
    ],
  });
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
  delete global[key];
  const api = new module.MobileApi() as MobileApi;
  api.token = "a-long-lived-secret";
  return api;
}

test("mobile control streams carry Bearer auth and preserve all decisions until session close", async () => {
  const events: unknown[] = [];
  const abort = new AbortController();
  const api = await fixture(async (url, init) => {
    assert.equal(
      String(url),
      "https://api.example.com/api/episodes/episode/live-control?sessionId=session%2Fone",
    );
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer a-long-lived-secret",
    );
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.signal, abort.signal);
    return new Response(
      '{"type":"ready","sessionId":"session/one"}\n{"type":"closed"}\n',
      { headers: { "content-type": "application/x-ndjson" } },
    );
  });
  await api.control("episode", "session/one", abort.signal, (event) =>
    events.push(event),
  );
  assert.deepEqual(events, [
    { type: "ready", sessionId: "session/one" },
    { type: "closed" },
  ]);
});

test("cancelled or account-replaced mobile streams cannot apply queued decisions", async () => {
  for (const replace of [true, false]) {
    let respond!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      respond = resolve;
    });
    const api = await fixture(async () => response);
    const controller = new AbortController(),
      events: unknown[] = [];
    const reading = api.control(
      "episode",
      "session",
      controller.signal,
      (event) => events.push(event),
    );
    if (replace) api.token = "different-account";
    else controller.abort();
    respond(
      new Response(
        '{"type":"ready","sessionId":"session"}\n{"type":"closed"}\n',
        { headers: { "content-type": "application/x-ndjson" } },
      ),
    );
    await reading;
    assert.deepEqual(events, []);
  }
});

test("mobile control authentication expiry affects only the credential that made the request", async () => {
  let respond!: (response: Response) => void;
  const api = await fixture(
    async () =>
      new Promise((resolve) => {
        respond = resolve;
      }),
  );
  let expired = 0;
  api.onExpired = () => {
    expired++;
  };
  const pending = api.control(
    "episode",
    "session",
    new AbortController().signal,
    () => {},
  );
  api.token = "new-account";
  respond(Response.json({ error: "Expired" }, { status: 401 }));
  await assert.rejects(pending, /Expired/);
  assert.equal(expired, 0);
  const current = api.control(
    "episode",
    "session",
    new AbortController().signal,
    () => {},
  );
  respond(Response.json({ error: "Expired" }, { status: 401 }));
  await assert.rejects(current, /Expired/);
  assert.equal(expired, 1);
});

test("mobile execution acknowledgements use authenticated PUT and reject inactive sessions", async (t) => {
  const api = await fixture(async () => {
    throw Error("Unexpected stream");
  });
  const signal = new AbortController().signal;
  const update = {
    sessionId: "session",
    acknowledgement: { decisionId: "decision", applied: true },
    player: {},
  } as LiveControlUpdate;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(
      url,
      "https://api.example.com/api/episodes/episode/live-control",
    );
    assert.equal(init.method, "PUT");
    assert.equal(init.signal, signal);
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer a-long-lived-secret",
    );
    assert.deepEqual(JSON.parse(String(init.body)), update);
    return Response.json({ ok: false });
  });
  await assert.rejects(
    api.updateControl("episode", update, signal),
    /no longer active/,
  );
});

test("only controlled mobile sessions opt in to native conversation policy", async (t) => {
  const bodies: unknown[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({
        session: { id: "test-live" },
        transport: { sdp: "answer" },
      });
    },
  );
  const api = await fixture(fetch);
  api.token = null;
  const request = { sdp: "offer", atMs: 1000, history: [] };
  await api.live("episode", request);
  assert.equal(liveSchema.parse(bodies[0]).control, undefined);
  await api.live("episode", {
    ...request,
    control: {
      debug: false,
      player: {
        version: 0,
        revision: 1,
        sequence: 0,
        positionMs: 1000,
        wasPlaying: true,
        audibleSource: "podcast",
        config: createPlayerConfig(),
      },
    },
  });
  assert.equal(liveSchema.parse(bodies[1]).control?.client, "mobile");
});

test("restarting mobile closes its persisted orphan before creating a paid replacement", async (t) => {
  const token = "a-long-lived-secret";
  const storage = new Map([["aside.token", token]]),
    calls: string[] = [];
  let created = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      `Bearer ${token}`,
    );
    const action = url.split("/").at(-1)!;
    calls.push(action);
    if (action === "usage") {
      assert.deepEqual(JSON.parse(String(init.body)), {
        sessionId: "session-1",
        seconds: 0,
        finalized: false,
        closed: true,
      });
      return Response.json({ ok: true });
    }
    return Response.json({
      session: { id: `session-${++created}` },
      transport: { sdp: "answer" },
    });
  });
  const first = await fixture(fetch, storage);
  await first.live("episode", {} as Parameters<PlayerBackend["live"]>[1]);
  const restarted = await fixture(fetch, storage);
  await restarted.restore();
  await restarted.live("episode", {} as Parameters<PlayerBackend["live"]>[1]);
  assert.deepEqual(calls, ["live", "usage", "live"]);
  assert.equal(JSON.parse(storage.get("aside.live")!).sessionId, "session-2");
});

test("cancelling an upload with an expired credential cannot recurse into sign-out", async (t) => {
  const storage = new Map([
    [
      "aside.upload.account-a",
      JSON.stringify({
        id: "upload-a",
        file: { uri: "file:///pending" },
        parts: [],
      }),
    ],
  ]);
  const api = await fixture(async () => {
    throw Error("unexpected stream");
  }, storage);
  api.accountId = "account-a";
  let expired = 0,
    requests = 0;
  api.onExpired = () => {
    expired++;
  };
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init?: RequestInit) => {
      requests++;
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer a-long-lived-secret",
      );
      return Response.json({ error: "Expired" }, { status: 401 });
    },
  );
  await api.cancelUpload();
  assert.equal(expired, 0);
  assert.equal(requests, 1);
  assert.equal(storage.has("aside.upload.account-a"), false);
});

test("late cancellation cleans the old account without removing another account's upload", async (t) => {
  const storage = new Map([
    [
      "aside.upload.account-a",
      JSON.stringify({ id: "upload-a", file: { uri: "file:///a" } }),
    ],
    [
      "aside.upload.account-b",
      JSON.stringify({ id: "upload-b", file: { uri: "file:///b" } }),
    ],
  ]);
  const api = await fixture(async () => {
    throw Error("unexpected stream");
  }, storage);
  api.accountId = "account-a";
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 200 }),
  );
  const cancelling = api.cancelUpload();
  api.accountId = "account-b";
  api.token = "account-b-token";
  await cancelling;
  assert.equal(storage.has("aside.upload.account-a"), false);
  assert.equal(storage.has("aside.upload.account-b"), true);
});

const uploadFile = {
  uri: "file:///saved-audio",
  name: "audio.mp3",
  mimeType: "audio/mpeg",
  size: 20,
};
test("Android upload delegates bytes and saved parts to native even when notifications are denied", async () => {
  const storage = new Map<string, string>();
  const journal = {
    id: "upload-id",
    partSize: 8,
    file: uploadFile,
    parts: [{ partNumber: 1, etag: "first" }],
  };
  storage.set("aside.upload.account", JSON.stringify(journal));
  const calls: unknown[][] = [],
    cancelled: string[] = [];
  let state = "paused";
  const api = await fixture(
    async () => {
      throw Error("unexpected stream");
    },
    storage,
    {
      start: async (...args) => {
        calls.push(args);
        state = "done";
      },
      status: async () => ({ state, progress: 1 }),
      cancel: async (id) => {
        cancelled.push(id);
      },
    },
  );
  api.accountId = "account";
  const episode = { id: journal.id };
  api.request = async <T>(path: string): Promise<T> => {
    assert.equal(
      path,
      "/episodes/upload-id",
      "JS must not read or send upload bytes",
    );
    return episode as T;
  };
  assert.equal(
    await api.upload(uploadFile, new AbortController().signal, () => {}),
    episode,
  );
  assert.deepEqual(calls, [
    [
      journal.id,
      "https://api.example.com",
      "a-long-lived-secret",
      uploadFile.uri,
      20,
      8,
      JSON.stringify(journal.parts),
    ],
  ]);
  assert.deepEqual(cancelled, [journal.id]);
  assert.equal(storage.has("aside.upload.account"), false);
});
test("a native completed upload restores after process restart without reuploading", async () => {
  const storage = new Map([
    [
      "aside.upload.account",
      JSON.stringify({
        id: "completed",
        partSize: 8,
        file: uploadFile,
        parts: [],
      }),
    ],
  ]);
  const api = await fixture(
    async () => {
      throw Error("unexpected stream");
    },
    storage,
    {
      start: async () => {
        throw Error("must not restart completed transfer");
      },
      status: async () => ({ state: "done", progress: 1 }),
      cancel: async () => {},
    },
  );
  api.accountId = "account";
  api.request = async <T>(): Promise<T> => ({ id: "completed" }) as T;
  await api.upload(uploadFile, new AbortController().signal, () => {});
  assert.equal(storage.size, 0);
});
test("native upload failure retains the journal for explicit retry", async () => {
  const value = JSON.stringify({
    id: "paused",
    partSize: 8,
    file: uploadFile,
    parts: [],
  });
  const storage = new Map([["aside.upload.account", value]]);
  let starts = 0;
  const api = await fixture(
    async () => {
      throw Error("unexpected stream");
    },
    storage,
    {
      start: async () => {
        starts++;
      },
      status: async () => ({ state: "paused", progress: 0.4 }),
      cancel: async () => {
        throw Error("failure must not cancel the saved upload");
      },
    },
  );
  api.accountId = "account";
  await assert.rejects(
    api.upload(uploadFile, new AbortController().signal, () => {}),
    /Upload paused/,
  );
  assert.equal(starts, 1);
  assert.equal(storage.get("aside.upload.account"), value);
});

test("cancelling during native handoff stops the transfer and removes only its journal", async (t) => {
  const storage = new Map([
    [
      "aside.upload.account",
      JSON.stringify({
        id: "cancel-me",
        partSize: 8,
        file: uploadFile,
        parts: [],
      }),
    ],
  ]);
  const abort = new AbortController();
  const cancelled: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://api.example.com/api/uploads/cancel-me");
    assert.equal(init.method, "DELETE");
    return new Response("{}", { status: 200 });
  });
  const api = await fixture(
    async () => {
      throw Error("unexpected stream");
    },
    storage,
    {
      start: async () => {
        abort.abort();
      },
      status: async () => ({ state: "uploading", progress: 0 }),
      cancel: async (id) => {
        cancelled.push(id);
      },
    },
  );
  api.accountId = "account";
  await assert.rejects(
    api.upload(uploadFile, abort.signal, () => {}),
    { name: "AbortError" },
  );
  assert.deepEqual(cancelled, ["cancel-me"]);
  assert.equal(storage.size, 0);
});

test("browser sign-in exchanges the returned code with the verifier behind its challenge", async () => {
  const storage = new Map<string, string>();
  let challenge = "";
  let exchanged: { code: string; verifier: string } | undefined;
  const api = await fixture(
    async () => assert.fail("the exchange uses the ordinary request path"),
    storage,
    undefined,
    async (url, redirect) => {
      const start = new URL(url);
      assert.equal(start.origin + start.pathname, "https://api.example.com/api/auth/google");
      assert.equal(start.searchParams.get("scheme"), "aside");
      assert.equal(redirect, "aside://auth");
      challenge = start.searchParams.get("mobile")!;
      return { type: "success", url: `aside://auth?code=${"c".repeat(64)}` };
    },
  );
  api.token = null;
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    assert.equal(String(url), "https://api.example.com/api/auth/mobile/exchange");
    exchanged = JSON.parse(String(init?.body));
    return Response.json({
      user: { id: "user-1", email: "a@example.com", alias: "a", description: "", avatarUrl: null },
      token: "b".repeat(64),
    });
  }) as typeof fetch;
  const user = await api.browserSignIn("google").finally(() => {
    globalThis.fetch = original;
  });
  assert.equal(user?.id, "user-1");
  assert.equal(exchanged?.code, "c".repeat(64));
  assert.equal(
    createHash("sha256").update(exchanged!.verifier).digest("base64url"),
    challenge,
  );
  assert.equal(api.token, "b".repeat(64));
  assert.equal(storage.get("aside.token"), "b".repeat(64));
});

test("browser sign-in treats a cancelled provider page as no sign-in", async () => {
  const api = await fixture(
    async () => assert.fail("no exchange after cancellation"),
    new Map(),
    undefined,
    async () => ({ type: "success", url: "aside://auth?error=cancelled" }),
  );
  api.token = null;
  assert.equal(await api.browserSignIn("apple"), null);
  assert.equal(api.token, null);
});
