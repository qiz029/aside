import type { Env } from "./env.js";
import { HttpError, json, readJson } from "./http.js";
import { CloudStore } from "./store.js";
import { ipKey, isTrialTester } from "./trial-allowlist.js";

// Covers the longest supported audio (five hours) while quotas remain server-side.
const guestProofMs = 6 * 60 * 60 * 1000;

export async function enabled(env: Pick<Env, "DB" | "AI_ENABLED">) {
  return (
    env.AI_ENABLED !== "false" &&
    !!(
      await env.DB.prepare(
        "SELECT enabled FROM trial_control WHERE id=1",
      ).first<{ enabled: number }>()
    )?.enabled &&
    !(await env.DB.prepare("SELECT owner FROM trial_breakers LIMIT 1").first())
  );
}
async function burst(request: Request, env: Env, owner: string) {
  const minute = Math.floor(Date.now() / 60000);
  const store = new CloudStore(env.DB, env.AUDIO);
  try {
    await store.reserve(`burst:${minute}:${owner}`, 12);
    await store.reserve(`burst:${minute}:ip:${await ipKey(request, env)}`, 60);
  } catch (error) {
    if (error instanceof HttpError && error.status === 429)
      throw new HttpError(429, "请求过于频繁，请一分钟后再试");
    throw error;
  }
}
export async function trialRoute(request: Request, env: Env, owner: string, accountId: string | null) {
  if (request.method === "GET") {
    const proof = accountId ? null : await env.DB.prepare(
      "SELECT expires FROM trial_proofs WHERE owner=? AND ip=?",
    )
      .bind(owner, await ipKey(request, env))
      .first<{ expires: number }>();
    return json({
      verified: !!accountId || (!!proof && proof.expires > Date.now()),
      siteKey: env.TURNSTILE_SITE_KEY,
      challenge: owner,
      enabled: await enabled(env),
      dailyLimitExempt: await isTrialTester(request, env),
    });
  }
  if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
  if (accountId) return json({ ok: true });
  await burst(request, env, owner);
  if (!env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_SITE_KEY)
    throw new HttpError(503, "试用验证尚未配置");
  const data = await readJson(request);
  if (typeof data.token !== "string" || data.token.length > 2048 || !data.token)
    throw new HttpError(400, "无效验证");
  const response = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET_KEY,
        response: data.token,
        remoteip: request.headers.get("cf-connecting-ip") ?? undefined,
      }),
      signal: AbortSignal.timeout(10000),
    },
  );
  const result = (await response.json()) as {
    success?: boolean;
    hostname?: string;
    action?: string;
    cdata?: string;
  };
  if (
    !response.ok ||
    !result.success ||
    result.hostname !== new URL(env.APP_ORIGIN).hostname ||
    result.action !== "aside-trial" ||
    result.cdata !== owner
  )
    throw new HttpError(403, "验证失败，请重试");
  await env.DB.prepare(
    "INSERT INTO trial_proofs VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET ip=excluded.ip,expires=excluded.expires",
  )
    .bind(owner, await ipKey(request, env), Date.now() + guestProofMs)
    .run();
  return json({ ok: true });
}
export async function authorize(request: Request, env: Env, owner: string, accountId: string | null) {
  await burst(request, env, owner);
  if (!(await enabled(env)))
    throw new HttpError(503, "今日 AI 试用暂时关闭，仍可继续收听");
  if (accountId) return;
  if (!env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_SITE_KEY)
    throw new HttpError(503, "试用验证尚未配置");
  const proof = await env.DB.prepare(
    "SELECT expires FROM trial_proofs WHERE owner=? AND ip=?",
  )
    .bind(owner, await ipKey(request, env))
    .first<{ expires: number }>();
  if (!proof || proof.expires <= Date.now())
    throw new HttpError(403, "请先完成试用验证", "trial_verification_required");
}
export async function acquire(env: Env, owner: string, kind: string) {
  const token = crypto.randomUUID(),
    now = Date.now();
  const result = await env.DB.prepare(
    `INSERT INTO trial_leases(owner,kind,token,expires)
    SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM trial_leases WHERE kind=? AND (kind='live' OR expires>?))<10
    ON CONFLICT(owner,kind) DO UPDATE SET token=excluded.token,expires=excluded.expires WHERE trial_leases.kind!='live' AND trial_leases.expires<=? RETURNING token`,
  )
    .bind(owner, kind, token, now + 90000, kind, now, now)
    .first();
  if (!result)
    throw new HttpError(429, "已有请求正在进行，或试用繁忙，请稍后再试");
  return token;
}
export async function release(
  env: Env,
  owner: string,
  kind: string,
  token: string,
) {
  await env.DB.prepare(
    "DELETE FROM trial_leases WHERE owner=? AND kind=? AND token=?",
  )
    .bind(owner, kind, token)
    .run();
}
export async function budget(
  env: Env,
  owner: string,
  kind: string,
  request?: Request,
) {
  // Test traffic must not consume the public pool or be blocked by its exhaustion.
  // authorize() and acquire() still enforce verification, rate limits and safety.
  if (request && await isTrialTester(request, env)) return;
  const store = new CloudStore(env.DB, env.AUDIO),
    day = new Date().toISOString().slice(0, 10);
  await store.reserve(`trial:${day}:${kind}:${owner}`, 5);
  if (request)
    await store.reserve(
      `trial:${day}:${kind}:ip:${await ipKey(request, env)}`,
      kind === "live" ? 10 : 20,
    );
  await store.reserve(
    `trial:${day}:${kind}:global`,
    kind === "live" ? 10 : 100,
  );
}
export function boundedHistory(history: { text: string }[]) {
  if (
    history.length > 20 ||
    history.some((t) => t.text.length > 2000) ||
    history.reduce((n, t) => n + t.text.length, 0) > 8000
  )
    throw new HttpError(413, "问题或对话过长，请开始新的对话");
}
export function validateWav(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (at: number) =>
    new TextDecoder().decode(bytes.subarray(at, at + 4));
  if (
    bytes.length < 44 ||
    str(0) !== "RIFF" ||
    str(8) !== "WAVE" ||
    v.getUint32(4, true) + 8 !== bytes.length
  )
    throw new HttpError(400, "无效 WAV 录音");
  let rate = 0,
    size = 0,
    fmt = false;
  for (let p = 12; p + 8 <= bytes.length;) {
    const n = v.getUint32(p + 4, true),
      end = p + 8 + n;
    if (end > bytes.length) throw new HttpError(400, "无效 WAV 录音");
    if (str(p) === "fmt ") {
      if (n < 16 || fmt) throw new HttpError(400, "无效 WAV 格式");
      const channels = v.getUint16(p + 10, true),
        sampleRate = v.getUint32(p + 12, true),
        bits = v.getUint16(p + 22, true),
        align = v.getUint16(p + 20, true);
      rate = v.getUint32(p + 16, true);
      fmt = true;
      if (
        v.getUint16(p + 8, true) !== 1 ||
        channels !== 1 ||
        bits !== 16 ||
        sampleRate < 8000 ||
        sampleRate > 48000 ||
        align !== 2 ||
        rate !== sampleRate * 2
      )
        throw new HttpError(400, "录音需要单声道 PCM WAV");
    }
    if (str(p) === "data") size += n;
    p = end + (n % 2);
  }
  if (!fmt || !size || size % 2 || size / rate > 30)
    throw new HttpError(413, "每次问题录音最多 30 秒");
}
