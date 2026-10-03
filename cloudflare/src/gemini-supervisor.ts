import { DurableObject } from "cloudflare:workers";
import type { Analysis } from "@aside/engine/core";
import {
  liveControlUpdateSchema,
  type LiveRequest,
  type LiveResult,
} from "@aside/engine/contracts";
import { LiveControl } from "../../backend/src/live-control.js";
import {
  GeminiLiveProtocol,
  geminiSetup,
} from "../../backend/src/gemini-live.js";
import { fetchWebSocketUpgrade } from "../../backend/src/websocket-upgrade.js";
import { liveSessionPolicy } from "../../backend/src/live-session-policy.js";
import { CloudStore } from "./store.js";
import { enabled, release } from "./trial.js";
import type { Env } from "./env.js";
interface State {
  owner: string;
  token: string;
  episode: string;
  session: string;
  ticket?: string;
  deadline: number;
  seconds: number;
  connectedAt?: number;
}
/** Owns both socket ends. Disconnecting either end ends the paid session.
 * The short-lived, single-use ticket authorizes only this episode/session. */
export class GeminiSupervisor extends DurableObject<Env> {
  private upstream?: WebSocket;
  private client?: WebSocket;
  private control?: LiveControl;
  private protocol?: GeminiLiveProtocol;
  private setup?: ReturnType<typeof geminiSetup>;
  private supplierClosed?: Promise<void>;
  private pending: Promise<unknown> = Promise.resolve();
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.pending.then(run, run);
    this.pending = result.catch(() => {});
    return result;
  }
  start(
    owner: string,
    token: string,
    episode: string,
    analysis: Analysis,
    data: LiveRequest,
    accountId: string,
  ): Promise<LiveResult> {
    return this.serial(async () => {
      if (await this.ctx.storage.get("state"))
        throw Error("Voice session already active");
      const policy = liveSessionPolicy(this.env, !!accountId);
      const state: State = {
        owner,
        token,
        episode,
        session: `gemini_${crypto.randomUUID()}`,
        ticket: crypto.randomUUID(),
        deadline: Date.now() + 30000,
        seconds: policy.seconds,
      };
      try {
        if (!this.env.GEMINI_API_KEY) throw Error("Gemini is not configured");
        await this.ctx.storage.put("state", state);
        await this.ctx.storage.setAlarm(state.deadline);
        this.setup = geminiSetup(
          analysis,
          data.atMs,
          data.history,
          data.control,
        );
        if (data.control)
          this.control = new LiveControl(
            state.session,
            data.control,
            analysis,
            (event) => this.protocol?.control(event),
            undefined,
            policy.intentCalls,
            undefined,
            new CloudStore(this.env.DB, this.env.AUDIO).transcriptReader(
              episode,
              owner,
            ),
          );
        await this.env.DB.prepare(
          "INSERT INTO voice_usage(session_id,owner_id,episode_id) VALUES(?,?,?)",
        )
          .bind(state.session, owner, episode)
          .run();
        const url = new URL("/api/live-audio", this.env.APP_ORIGIN);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        for (const [key, value] of Object.entries({
          owner,
          episode,
          sessionId: state.session,
          ticket: state.ticket!,
        }))
          url.searchParams.set(key, value);
        return {
          session: { id: state.session },
          provider: "gemini",
          transport: { sdp: "", websocketUrl: url.href },
          control: !!data.control,
          renewable: true,
        };
      } catch (error) {
        await this.end(state);
        throw error;
      }
    });
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/audio")
      return this.serial(() => this.connectAudio(request));
    const state = await this.ctx.storage.get<State>("state");
    if (
      !state ||
      state.session !== url.searchParams.get("sessionId") ||
      state.episode !== url.searchParams.get("episode")
    )
      return new Response(null, { status: 404 });
    if (!this.control || Date.now() >= state.deadline)
      return new Response(null, { status: 410 });
    if (request.method === "GET") return this.control.subscribe();
    if (request.method === "PUT") {
      const result = liveControlUpdateSchema.safeParse(await request.json());
      return Response.json(
        result.success
          ? { ok: this.control.update(result.data) }
          : { error: "Invalid player state" },
        { status: result.success ? 200 : 400 },
      );
    }
    return new Response(null, { status: 405 });
  }
  private async connectAudio(request: Request): Promise<Response> {
    const url = new URL(request.url),
      state = await this.ctx.storage.get<State>("state");
    if (
      request.method !== "GET" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    )
      return new Response(null, { status: 426 });
    if (
      !state?.ticket ||
      state.ticket !== url.searchParams.get("ticket") ||
      state.session !== url.searchParams.get("sessionId") ||
      state.episode !== url.searchParams.get("episode") ||
      Date.now() >= state.deadline
    )
      return new Response(null, { status: 403 });
    // Consume before awaiting any network I/O. A replay cannot open another supplier.
    delete state.ticket;
    await this.ctx.storage.put("state", state);
    try {
      if (!this.setup || !(await enabled(this.env)))
        throw Error("Session unavailable");
      const endpoint = new URL(
        "https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
      );
      endpoint.searchParams.set("key", this.env.GEMINI_API_KEY!);
      const result = await fetchWebSocketUpgrade(endpoint.href, {
        Upgrade: "websocket",
      });
      if (!result.webSocket) throw Error("Gemini connection unavailable");
      const upstream = (this.upstream = result.webSocket);
      upstream.binaryType = "arraybuffer";
      upstream.accept();
      const pair = new WebSocketPair(),
        client = (this.client = pair[1]);
      client.accept();
      state.connectedAt = Date.now();
      state.deadline = state.connectedAt + state.seconds * 1000;
      await this.ctx.storage.put("state", state);
      await this.ctx.storage.setAlarm(Date.now() + 5000);
      const send = (socket: WebSocket, event: unknown) => {
        if (socket.readyState !== 1) throw Error("Live socket closed");
        socket.send(JSON.stringify(event));
      };
      const end = () => this.ctx.waitUntil(this.serial(() => this.end(state)));
      const protocol = (this.protocol = new GeminiLiveProtocol({
        upstream: (event) => send(upstream, event),
        client: (event) => send(client, event),
        control: (event) => this.control?.receive(event),
        close: end,
        now: () => Date.now() - state.connectedAt!,
      }));
      let window = Date.now(),
        bytes = 0,
        packets = 0;
      client.addEventListener("message", (event) => {
        try {
          if (typeof event.data !== "string" || event.data.length > 90000)
            throw Error("Invalid frame");
          if (Date.now() - window >= 1000) {
            window = Date.now();
            bytes = packets = 0;
          }
          bytes += event.data.length;
          packets++;
          if (bytes > 200000 || packets > 120)
            throw Error("Audio backpressure");
          protocol.client(JSON.parse(event.data));
        } catch {
          end();
        }
      });
      let setupComplete = false;
      const setupTimer = setTimeout(() => {
        if (!setupComplete) end();
      }, 15000);
      upstream.addEventListener("message", (event) => {
        try {
          const raw =
            typeof event.data === "string"
              ? event.data
              : new TextDecoder().decode(event.data);
          if (raw.length > 2000000) throw Error("Invalid supplier frame");
          const message = JSON.parse(raw);
          if (message.setupComplete) {
            setupComplete = true;
            clearTimeout(setupTimer);
          }
          if (message.usageMetadata)
            console.log("Aside Gemini usage", {
              session: state.session,
              model: "gemini-3.8-live",
              usage: message.usageMetadata,
            });
          protocol.receive(message);
        } catch (error) {
          console.warn("Aside Gemini event rejected", {
            kind: typeof event.data,
            reason: error instanceof Error ? error.name : "invalid event",
          });
          end();
        }
      });
      this.supplierClosed = new Promise<void>((resolve) =>
        upstream.addEventListener("close", () => resolve(), { once: true }),
      );
      for (const socket of [client, upstream]) {
        socket.addEventListener("close", () => {
          clearTimeout(setupTimer);
          end();
        });
        socket.addEventListener("error", () => {
          clearTimeout(setupTimer);
          end();
        });
      }
      send(upstream, this.setup);
      this.setup = undefined;
      return new Response(null, { status: 101, webSocket: pair[0] });
    } catch {
      await this.end(state);
      return new Response(null, { status: 503 });
    }
  }
  close(sessionId: string) {
    return this.serial(async () => {
      const state = await this.ctx.storage.get<State>("state");
      if (state?.session === sessionId) await this.end(state);
    });
  }
  private async end(state: State) {
    if ((await this.ctx.storage.get<State>("state"))?.session !== state.session)
      return;
    this.protocol?.stop();
    this.protocol = undefined;
    const seconds = state.connectedAt
      ? Math.min(
          state.seconds,
          Math.max(0, (Date.now() - state.connectedAt) / 1000),
        )
      : 0;
    let finalized = !this.upstream;
    try {
      this.upstream?.close(1000);
    } catch {}
    if (this.supplierClosed) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      finalized = await Promise.race([
        this.supplierClosed.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 1500);
        }),
      ]);
      clearTimeout(timer);
    }
    this.upstream = undefined;
    this.supplierClosed = undefined;
    try {
      if (finalized)
        this.client?.send(
          JSON.stringify({ type: "session.closed", usage: { seconds } }),
        );
      this.client?.close(1000);
    } catch {}
    this.client = undefined;
    this.control?.close();
    this.control = undefined;
    this.setup = undefined;
    await this.env.DB.prepare(
      "UPDATE voice_usage SET seconds=MAX(seconds,?),finalized=? WHERE session_id=? AND owner_id=?",
    )
      .bind(seconds, finalized ? 1 : 0, state.session, state.owner)
      .run();
    await release(this.env, state.owner, "live", state.token);
    await this.ctx.storage.delete("state");
    await this.ctx.storage.deleteAlarm();
  }
  alarm() {
    return this.serial(async () => {
      const state = await this.ctx.storage.get<State>("state");
      if (!state) return;
      if (
        !this.upstream ||
        !this.client ||
        Date.now() >= state.deadline ||
        !(await enabled(this.env))
      ) {
        await this.end(state);
        return;
      }
      try {
        this.client.send(
          JSON.stringify({
            type: "session.usage.updated",
            usage: { seconds: (Date.now() - state.connectedAt!) / 1000 },
          }),
        );
      } catch {
        await this.end(state);
        return;
      }
      await this.ctx.storage.setAlarm(
        Math.min(state.deadline, Date.now() + 5000),
      );
    });
  }
}
