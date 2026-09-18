import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";
import type { Analysis, Turn } from "@aside/engine/core";
import {
  InteractiveProvider,
  LiveCreationRejected,
} from "../../backend/src/interactive-provider.js";
import { enabled, release } from "./trial.js";
import {
  liveControlUpdateSchema,
  type LiveRequest,
} from "@aside/engine/contracts";
import { LiveControl } from "../../backend/src/live-control.js";
import { recordJevShadow, recordQuestionUsage } from "./usage.js";
import { createJevShadow } from "../../backend/src/jev-shadow.js";
import { fetchWebSocketUpgrade } from "../../backend/src/websocket-upgrade.js";
import {
  liveSessionExpired,
  liveSessionPolicy,
} from "../../backend/src/live-session-policy.js";
interface State {
  owner: string;
  token: string;
  episode: string;
  deadline: number;
  session?: string;
  closing?: boolean;
  confirmed?: boolean;
}
/**
 * The supplier no longer knows this session. Its `session.closed` frame can
 * never arrive, so the attach can never succeed and must not be retried.
 */
class SessionGone extends Error {}

/**
 * How long past its deadline a session may stay unconfirmed before the
 * supervisor releases it anyway. The breaker it leaves behind pauses every
 * listener's AI, so an unbounded wait turns one lost close acknowledgement
 * into a site-wide outage.
 */
const closeGraceMs = 15 * 60 * 1000;

/** The browser never owns the lease or the authoritative close acknowledgement. */
export class LiveSupervisor extends DurableObject<Env> {
  private socket?: WebSocket;
  private control?: LiveControl;
  private pending: Promise<unknown> = Promise.resolve();
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.pending.then(run, run);
    this.pending = next.catch(() => {});
    return next;
  }

  start(
    owner: string,
    token: string,
    episode: string,
    sdp: string,
    analysis: Analysis,
    atMs: number,
    history: Turn[],
    control?: LiveRequest["control"],
    accountId: string | null = null,
  ) {
    return this.serial(() =>
      this.startSession(
        owner,
        token,
        episode,
        sdp,
        analysis,
        atMs,
        history,
        control,
        accountId,
      ),
    );
  }
  private async startSession(
    owner: string,
    token: string,
    episode: string,
    sdp: string,
    analysis: Analysis,
    atMs: number,
    history: Turn[],
    control?: LiveRequest["control"],
    accountId: string | null = null,
  ) {
    const policy = liveSessionPolicy(this.env, !!accountId);
    const previous = await this.ctx.storage.get<State>("state");
    if (previous?.confirmed) await this.confirm(previous);
    if (await this.ctx.storage.get("state"))
      throw Error("Voice session already active");
    const state: State = {
      owner,
      token,
      episode,
      deadline: Date.now() + 120000,
    };
    await this.ctx.storage.put("state", state);
    await this.ctx.storage.setAlarm(Date.now() + 10000);
    try {
      const result = await new InteractiveProvider(
        this.env.OPENAI_API_KEY!,
        this.env.ASIDE_BACKEND_MODEL,
      ).createLive(
        sdp,
        analysis,
        atMs,
        history,
        control
          ? {
              trial: !accountId,
              ...(control.client === "mobile"
                ? { player: control.player }
                : {}),
            }
          : undefined,
      );
      state.session = result.session.id;
      // Connection creation must not consume the listener's session allowance.
      state.deadline = Date.now() + policy.seconds * 1000;
      if (control) {
        // The backend model is invoked by GPT-Live itself; this side only
        // executes its function calls and reports its cost from the events.
        this.control = new LiveControl(
          result.session.id,
          control,
          analysis,
          (event) => {
            if (this.socket?.readyState === 1)
              this.socket.send(JSON.stringify(event));
            else
              console.warn("Aside voice sideband unavailable for tool result", {
                type: event.type,
              });
          },
          (totals) =>
            this.ctx.waitUntil(
              recordQuestionUsage(this.env, {
                owner,
                accountId,
                episodeId: episode,
                totals,
              }),
            ),
          policy.intentCalls,
          this.env.OPEN_ROUTER_API_KEY
            ? createJevShadow(
                this.env.OPEN_ROUTER_API_KEY,
                (entry) =>
                  this.ctx.waitUntil(recordJevShadow(this.env, entry)),
                {
                  fetch: (input, init) => fetch(input, init),
                  now: Date.now,
                  after: (ms, run) => {
                    const timer = setTimeout(run, ms);
                    return () => clearTimeout(timer);
                  },
                },
              )
            : undefined,
        );
      }
      await this.ctx.storage.put("state", state);
      await this.env.DB.prepare(
        "INSERT INTO voice_usage(session_id,owner_id,episode_id) VALUES(?,?,?)",
      )
        .bind(state.session, owner, episode)
        .run();
      await this.attach(state);
      if (Date.now() >= state.deadline || !(await enabled(this.env)))
        throw Error("Trial stopped");
      return { ...result, ...(control ? { control: true } : {}) };
    } catch (error) {
      this.control?.close();
      if (error instanceof LiveCreationRejected && !state.session) {
        await this.ctx.storage.delete("state");
        await this.ctx.storage.deleteAlarm();
        await release(this.env, owner, "live", token);
        throw error;
      }
      state.closing = true;
      await this.ctx.storage.put("state", state);
      await this.breaker(state);
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      throw error;
    }
  }
  /** The public API authenticates the owner before selecting this object. */
  async fetch(request: Request) {
    const url = new URL(request.url);
    const state = await this.ctx.storage.get<State>("state");
    if (
      !state ||
      state.session !== url.searchParams.get("sessionId") ||
      state.episode !== url.searchParams.get("episode")
    )
      return Response.json(
        {
          error:
            "Voice control session is no longer available. Please reconnect the microphone.",
        },
        { status: 404 },
      );
    if (Date.now() >= state.deadline) {
      this.control?.close(liveSessionExpired);
      return Response.json(
        { error: liveSessionExpired, code: "voice_session_expired" },
        { status: 410 },
      );
    }
    if (state.closing || !this.control)
      return Response.json(
        {
          error:
            "Voice control session ended. Please reconnect the microphone.",
        },
        { status: 410 },
      );
    if (request.method === "GET") return this.control.subscribe();
    if (request.method === "PUT") {
      const parsed = liveControlUpdateSchema.safeParse(await request.json());
      if (!parsed.success)
        return Response.json(
          { error: "Invalid player state" },
          { status: 400 },
        );
      return Response.json({ ok: this.control.update(parsed.data) });
    }
    return new Response(null, { status: 405 });
  }
  /**
   * Releases everything a finished session holds. `finalize` marks the usage
   * row as supplier-confirmed, which only a real `session.closed` frame or a
   * 404 from the supplier may claim.
   */
  private async retire(state: State, finalize: boolean) {
    this.control?.close();
    this.control = undefined;
    await this.env.DB.batch([
      ...(finalize && state.session
        ? [
            this.env.DB.prepare(
              "UPDATE voice_usage SET finalized=1 WHERE session_id=? AND owner_id=?",
            ).bind(state.session, state.owner),
          ]
        : []),
      this.env.DB.prepare("DELETE FROM trial_breakers WHERE owner=?").bind(
        state.owner,
      ),
      this.env.DB.prepare(
        "DELETE FROM trial_leases WHERE owner=? AND kind='live' AND token=?",
      ).bind(state.owner, state.token),
    ]);
    await this.ctx.storage.delete("state");
    await this.ctx.storage.deleteAlarm();
    this.socket?.close();
    this.socket = undefined;
  }

  /**
   * An attach that cannot be established must not pause every listener's AI
   * forever. A 404 means the supplier dropped the session; anything else is
   * still given the whole grace window past the deadline before release.
   */
  private async handleAttachFailure(state: State, error: unknown) {
    const dropped = error instanceof SessionGone;
    const expired = Date.now() > state.deadline + closeGraceMs;
    if (!dropped && !expired) {
      await this.breaker(state);
      return;
    }
    console.error(
      "Aside voice session released without a close acknowledgement",
      {
        owner: state.owner,
        session: state.session,
        dropped,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    await this.retire(state, dropped);
  }
  private async breaker(state: State) {
    await this.env.DB.prepare("INSERT OR IGNORE INTO trial_breakers VALUES(?)")
      .bind(state.owner)
      .run();
  }
  private async attach(state: State) {
    if (this.socket?.readyState === 1) return;
    if (!state.session)
      throw Error("Unknown session; operator reconciliation required");
    const response = await fetchWebSocketUpgrade(
      `https://api.openai.com/v1/live/sessions/${encodeURIComponent(state.session)}/attach`,
      {
        Upgrade: "websocket",
        Authorization: `Bearer ${this.env.OPENAI_API_KEY}`,
      },
    );
    const socket = response.webSocket;
    if (!socket) {
      // A 404 is the supplier saying the session is over; anything else is
      // transient and keeps the breaker until the close is confirmed.
      if (response.status === 404) throw new SessionGone(state.session);
      throw Error("Sideband unavailable");
    }
    socket.accept();
    this.socket = socket;
    const connectedAt = Date.now();
    let supplierClosed = false;
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      try {
        const message = JSON.parse(event.data);
        this.control?.receive(message);
        if (message.type === "session.closed") {
          supplierClosed = true;
          this.control?.close();
          this.ctx.waitUntil(this.serial(() => this.confirm(state)));
        }
      } catch {
        /* Ignore non-JSON frames. */
      }
    });
    socket.addEventListener("close", (event) => {
      if (this.socket === socket) {
        this.socket = undefined;
        if (supplierClosed || state.closing) {
          this.control?.close();
          return;
        }
        const ageMs = Date.now() - connectedAt;
        console.warn("Live sideband transport closed", {
          code: event.code,
          wasClean: event.wasClean,
          ageMs,
        });
        this.control?.close(
          `Live sideband disconnected (code ${event.code}, after ${Math.round(ageMs / 1000)}s). Please reconnect the microphone.`,
        );
      }
    });
    socket.addEventListener("error", () => {
      if (this.socket === socket) {
        this.socket = undefined;
        this.control?.close(
          "Live sideband failed. Please reconnect the microphone.",
        );
      }
    });
  }
  private async confirm(state: State) {
    const current = await this.ctx.storage.get<State>("state");
    if (current?.token !== state.token) return;
    // Persist the terminal acknowledgement before D1 changes; alarm can finish after a restart.
    await this.ctx.storage.put("state", { ...current, confirmed: true });
    await this.retire(state, true);
  }
  close(session: string) {
    return this.serial(() => this.closeSession(session));
  }
  private async closeSession(session: string) {
    const state = await this.ctx.storage.get<State>("state");
    if (!state || state.session !== session) return;
    state.closing = true;
    await this.ctx.storage.put("state", state);
    await this.ctx.storage.setAlarm(Date.now() + 1000);
    try {
      await this.attach(state);
      this.socket!.send(JSON.stringify({ type: "session.close" }));
    } catch (error) {
      await this.handleAttachFailure(state, error);
    }
  }
  alarm() {
    return this.serial(() => this.tick());
  }
  private async tick() {
    const state = await this.ctx.storage.get<State>("state");
    if (!state) return;
    if (state.confirmed) {
      await this.confirm(state);
      return;
    }
    // Re-arm before network work so a transient failure cannot orphan a session.
    await this.ctx.storage.setAlarm(
      state.deadline > Date.now()
        ? Math.min(state.deadline, Date.now() + 5000)
        : Date.now() + 5000,
    );
    try {
      if (!state.session) {
        if (!state.closing && Date.now() < state.deadline) return;
        await this.breaker(state);
        // A creation whose outcome is unknown has no session id to reconnect
        // to, so nothing can ever confirm the close. The lease stays as the
        // trace and the per-owner block, but the global pause must not.
        if (Date.now() <= state.deadline + closeGraceMs) return;
        // The lease token is a credential: the log carries the owner only,
        // which is enough to find the lease it left behind.
        console.error(
          "Aside voice creation unconfirmed; releasing the global breaker",
          { owner: state.owner },
        );
        await this.env.DB.prepare("DELETE FROM trial_breakers WHERE owner=?")
          .bind(state.owner)
          .run();
        await this.ctx.storage.delete("state");
        await this.ctx.storage.deleteAlarm();
        return;
      }
      if (Date.now() >= state.deadline) this.control?.close(liveSessionExpired);
      await this.attach(state);
      if (
        state.closing ||
        Date.now() >= state.deadline ||
        !(await enabled(this.env))
      ) {
        const waitingForClose = state.closing;
        state.closing = true;
        await this.ctx.storage.put("state", state);
        if (waitingForClose) await this.breaker(state);
        this.socket!.send(JSON.stringify({ type: "session.close" }));
      }
    } catch (error) {
      await this.handleAttachFailure(state, error);
    }
  }
}
