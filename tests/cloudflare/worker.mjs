import api from "../../cloudflare/src/api.ts";
import { WorkflowEntrypoint } from "cloudflare:workers";
export default api;
export class TestAnalysis extends WorkflowEntrypoint {
  async run(event, step) {
    return step.do("record", async () => {
      await this.env.DB.prepare("INSERT OR IGNORE INTO test_jobs VALUES(?)")
        .bind(event.payload.episodeId)
        .run();
      return event.payload;
    });
  }
}

export { EpisodeAnalysis } from "../../cloudflare/src/index.ts";
import { DurableObject } from "cloudflare:workers";
/** Fake container transport; real FFmpeg is covered separately. */
export class TestMedia extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/prepare") {
      const source = await request.text();
      if (source === "invalid-long")
        return Response.json({ error: "单个音频不能超过 5 小时" }, { status: 422 });
      await this.ctx.storage.put("ready", true);
      return Response.json({
        durationMs: 1000,
        mimeType: "audio/mpeg",
        cover: true,
        pauses: [],
        plan: [{ offsetMs: 0, durationMs: 1000 }],
      });
    }
    if (url.pathname === "/chunk") {
      if (!(await this.ctx.storage.get("ready")))
        return new Response(null, { status: 409 });
      return new Response("encoded audio");
    }
    if (url.pathname === "/cover") {
      if (!(await this.ctx.storage.get("ready")))
        return new Response(null, { status: 409 });
      return new Response("jpeg bytes");
    }
    await this.ctx.storage.deleteAll();
    return Response.json({ ok: true });
  }
}

import { LiveSupervisor } from "../../cloudflare/src/live-supervisor.ts";
export class TestLive extends LiveSupervisor {
  async remainingMs() {
    const state = await this.ctx.storage.get("state");
    return state.deadline - Date.now();
  }
  async elapse(ms, tick = false) {
    const state = await this.ctx.storage.get("state");
    state.deadline -= ms;
    await this.ctx.storage.put("state", state);
    if (tick) await this.alarm();
  }
  async expire() {
    return this.expireAt(0);
  }
  /** Drops the sideband socket so the next tick must attach again. */
  async detach() {
    this.socket?.close();
    this.socket = undefined;
  }
  /** Forces the session deadline so the supervisor sees it as past due. */
  async expireAt(deadline) {
    const state = await this.ctx.storage.get("state");
    if (state) {
      state.deadline = deadline;
      await this.ctx.storage.put("state", state);
    }
    await this.alarm();
  }
}
