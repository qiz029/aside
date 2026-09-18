import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import type { PlayerBackend } from "@aside/player-runtime/ports";
type MobileApi = Required<
  Pick<PlayerBackend, "control" | "updateControl" | "live" | "usage">
> & {
  token: string | null;
  onExpired?: () => void;
  restore(): Promise<void>;
};
import type { LiveControlUpdate } from "@aside/engine/contracts";
import { liveSchema } from "@aside/engine/contracts";
import { createPlayerConfig } from "@aside/engine/player";

async function fixture(
  fetcher: typeof fetch,
  storage = new Map<string, string>(),
) {
  const key = `mobileApi_${crypto.randomUUID()}`;
  const global = globalThis as unknown as Record<string, unknown>;
  global[key] = { fetcher, storage };
  const modules: Record<string, string> = {
    "expo-constants":
      'export default {expoConfig:{extra:{apiUrl:"https://api.example.com"}}};',
    "expo-secure-store": `const store = globalThis[${JSON.stringify(key)}].storage;
       export const getItemAsync=async(key)=>store.get(key)??null,
         setItemAsync=async(key,value)=>{store.set(key,value)},
         deleteItemAsync=async(key)=>{store.delete(key)};`,
    "expo-file-system": "export class File {}",
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
          builder.onResolve({ filter: /^expo(?:-|\/)/ }, ({ path }) => ({
            path,
            namespace: "os",
          }));
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
      new Headers(init.headers).get("Authorization"),
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
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({ session: { id: "test-live" }, transport: { sdp: "answer" } });
  });
  const api = await fixture(fetch);
  api.token = null;
  const request = { sdp: "offer", atMs: 1000, history: [] };
  await api.live("episode", request);
  assert.equal(liveSchema.parse(bodies[0]).control, undefined);
  await api.live("episode", { ...request, control: { debug: false, player: {
    version: 0, revision: 1, sequence: 0, positionMs: 1000,
    wasPlaying: true, audibleSource: "podcast", config: createPlayerConfig(),
  } } });
  assert.equal(liveSchema.parse(bodies[1]).control?.client, "mobile");
});

test("restarting mobile closes its persisted orphan before creating a paid replacement", async (t) => {
  const token = "a-long-lived-secret";
  const storage = new Map([["aside.token", token]]),
    calls: string[] = [];
  let created = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(
      new Headers(init.headers).get("Authorization"),
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
