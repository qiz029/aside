import api from "../../cloudflare/src/api";
export {
  TestAnalysis,
  TestLive,
  EpisodeAnalysis,
} from "../../tests/cloudflare/worker.mjs";
import { TestMedia as BaseMedia } from "../../tests/cloudflare/worker.mjs";
export class TestMedia extends BaseMedia {
  async fetch(request: Request) {
    const url = new URL(request.url);
    url.host = "test-media";
    return fetch(new Request(url, request));
  }
}
export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (
      url.pathname === "/__fixture/voice" ||
      url.pathname === "/__fixture/device"
    ) {
      url.hostname = "test-voice-control";
      url.port = "";
      return fetch(new Request(url, request));
    }
    const response = await api.fetch(request, env, ctx);
    if (
      new URL(request.url).pathname === "/api/auth/mobile/email/start" &&
      response.ok
    ) {
      // Test-only deterministic code; real production verification, rate limits and session issuance still execute.
      const rows = await env.DB.prepare("SELECT email FROM auth_codes").all();
      for (const row of rows.results) {
        const bytes = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            `${env.SESSION_SECRET}:${row.email}:12345678`,
          ),
        );
        const hash = Array.from(new Uint8Array(bytes), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
        await env.DB.prepare("UPDATE auth_codes SET code_hash=? WHERE email=?")
          .bind(hash, row.email)
          .run();
      }
    }
    return response;
  },
};
