import { z } from "zod";
import type { Env } from "./env.js";
import { HttpError, json, readBody, readJson } from "./http.js";
import { CloudStore } from "./store.js";

const authCookie = "aside_auth";
const stateCookie = "aside_google_state";
const sessionLifetime = 30 * 86400000;
const emailSchema = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((x) => x.toLowerCase());
const profileSchema = z.object({
  alias: z.string().trim().min(1).max(40),
  description: z.string().trim().max(500),
});
interface UserRow {
  id: string;
  email: string;
  alias: string;
  description: string;
  avatar_key: string | null;
  google_picture: string | null;
}

function cookieValue(request: Request, name: string) {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(name + "="))
    ?.slice(name.length + 1);
}
function cookie(
  request: Request,
  name: string,
  value: string,
  maxAge: number,
  sameSite = "Strict",
) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure}`;
}
function randomHex(bytes: number) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}
async function hash(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
}
async function keyedHash(secret: string, value: string) {
  return hash(`${secret}:${value}`);
}
function publicUser(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    alias: row.alias,
    description: row.description,
    avatarUrl: row.avatar_key ? "/api/profile/avatar" : row.google_picture,
  };
}
async function userById(env: Env, id: string) {
  return env.DB.prepare("SELECT * FROM users WHERE id=?")
    .bind(id)
    .first<UserRow>();
}
export async function accountFromRequest(request: Request, env: Env) {
  const bearer = request.headers.get("authorization");
  const token = bearer
    ? /^Bearer ([a-f0-9]{64})$/.exec(bearer)?.[1]
    : cookieValue(request, authCookie);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const row = await env.DB.prepare(
    "SELECT u.* FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>? AND s.kind=?",
  )
    .bind(await hash(token), Date.now(), bearer ? "mobile" : "web")
    .first<UserRow>();
  return row;
}
function requireUser(user: UserRow | null): UserRow {
  if (!user) throw new HttpError(401, "请先登录");
  return user;
}
async function issueSession(
  request: Request,
  env: Env,
  userId: string,
  mobile = false,
) {
  const token = randomHex(32);
  await env.DB.prepare(
    "INSERT INTO auth_sessions(token_hash,user_id,expires,kind) VALUES(?,?,?,?)",
  )
    .bind(
      await hash(token),
      userId,
      Date.now() + sessionLifetime,
      mobile ? "mobile" : "web",
    )
    .run();
  return mobile
    ? token
    : cookie(request, authCookie, token, sessionLifetime / 1000);
}
async function claimVisitor(env: Env, visitor: string, userId: string) {
  // Only content owned by this signed anonymous visitor is transferred.
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE episodes SET owner_id=? WHERE owner_id=? AND public=0",
    ).bind(userId, visitor),
    env.DB.prepare("UPDATE uploads SET owner_id=? WHERE owner_id=?").bind(
      userId,
      visitor,
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO checkpoints(owner_id,episode_id,value) SELECT ?,episode_id,value FROM checkpoints WHERE owner_id=?",
    ).bind(userId, visitor),
    env.DB.prepare("DELETE FROM checkpoints WHERE owner_id=?").bind(visitor),
    env.DB.prepare("UPDATE voice_usage SET owner_id=? WHERE owner_id=?").bind(
      userId,
      visitor,
    ),
  ]);
}
async function findOrCreateUser(
  env: Env,
  email: string,
  alias: string,
  google?: { sub: string; picture?: string },
) {
  if (google) {
    const existing = await env.DB.prepare(
      "SELECT user_id FROM auth_identities WHERE provider='google' AND subject=?",
    )
      .bind(google.sub)
      .first<{ user_id: string }>();
    if (existing) {
      const linked = await userById(env, existing.user_id);
      if (!linked) throw new HttpError(503, "账号资料暂不可用");
      return linked;
    }
  }
  const now = Date.now();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users(id,email,alias,created_at,updated_at,google_picture) VALUES(?,?,?,?,?,?)",
  )
    .bind(
      id,
      email,
      alias.slice(0, 40) || email.split("@")[0],
      now,
      now,
      google?.picture ?? null,
    )
    .run();
  const row = await env.DB.prepare("SELECT * FROM users WHERE email=?")
    .bind(email)
    .first<UserRow>();
  if (!row) throw new HttpError(503, "无法创建账号");
  if (google) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO auth_identities(provider,subject,user_id) VALUES('google',?,?)",
    )
      .bind(google.sub, row.id)
      .run();
    const linked = await env.DB.prepare(
      "SELECT user_id FROM auth_identities WHERE provider='google' AND subject=?",
    )
      .bind(google.sub)
      .first<{ user_id: string }>();
    if (linked?.user_id !== row.id)
      throw new HttpError(409, "Google 账号已关联其他用户");
  }
  return row;
}
async function sendCode(request: Request, env: Env) {
  if (!env.EMAIL || !env.AUTH_EMAIL_FROM)
    throw new HttpError(503, "邮件登录尚未配置");
  const { email } = z
    .object({ email: emailSchema })
    .parse(await readJson(request));
  const now = Date.now();
  const hour = Math.floor(now / 3600000);
  const day = Math.floor(now / 86400000);
  const ip = await keyedHash(
    env.SESSION_SECRET,
    request.headers.get("cf-connecting-ip") ?? "local",
  );
  const limits = new CloudStore(env.DB, env.AUDIO);
  await limits.reserve(`auth:${hour}:ip:${ip}`, 20);
  // Cloudflare's initial account-wide quota is 200 emails/day. Leave room for
  // other sending domains on this account and for failed delivery attempts.
  await limits.reserve(`auth:${day}:global`, 100);
  const code = String(
    crypto.getRandomValues(new Uint32Array(1))[0] % 100000000,
  ).padStart(8, "0");
  const result = await env.DB.prepare(
    "INSERT INTO auth_codes(email,code_hash,expires,last_sent) VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash,expires=excluded.expires,last_sent=excluded.last_sent,attempts=0 WHERE auth_codes.last_sent<? RETURNING email",
  )
    .bind(
      email,
      await keyedHash(env.SESSION_SECRET, `${email}:${code}`),
      now + 600000,
      now,
      now - 60000,
    )
    .first();
  if (!result) return json({ ok: true });
  try {
    await env.EMAIL.send({
      from: { email: env.AUTH_EMAIL_FROM, name: "Aside" },
      to: email,
      subject: "Aside 登录验证码",
      text: `你的 Aside 登录验证码是 ${code}。10 分钟内有效。如果不是你发起的登录，请忽略此邮件。`,
    });
  } catch {
    await env.DB.prepare("DELETE FROM auth_codes WHERE email=? AND last_sent=?")
      .bind(email, now)
      .run();
    throw new HttpError(503, "邮件暂时无法发送，请稍后重试");
  }
  return json({ ok: true });
}
async function verifyCode(request: Request, env: Env, visitor: string) {
  const data = z
    .object({ email: emailSchema, code: z.string().regex(/^\d{8}$/) })
    .parse(await readJson(request));
  const hour = Math.floor(Date.now() / 3600000);
  const ip = await keyedHash(
    env.SESSION_SECRET,
    request.headers.get("cf-connecting-ip") ?? "local",
  );
  const limits = new CloudStore(env.DB, env.AUDIO);
  await limits.reserve(`auth:${hour}:verify:${ip}`, 100);
  await limits.reserve(`auth:${hour}:verify-global`, 5000);
  // Reserve an attempt atomically so concurrent guesses cannot exceed five.
  const row = await env.DB.prepare(
    "UPDATE auth_codes SET attempts=attempts+1 WHERE email=? AND expires>? AND attempts<5 RETURNING code_hash",
  )
    .bind(data.email, Date.now())
    .first<{ code_hash: string }>();
  if (!row) throw new HttpError(400, "验证码无效或已过期");
  const supplied = await keyedHash(
    env.SESSION_SECRET,
    `${data.email}:${data.code}`,
  );
  if (supplied !== row.code_hash) {
    throw new HttpError(400, "验证码无效或已过期");
  }
  // Consume the challenge before issuing a session; concurrent replays cannot both succeed.
  const consumed = await env.DB.prepare(
    "DELETE FROM auth_codes WHERE email=? AND code_hash=? RETURNING email",
  )
    .bind(data.email, supplied)
    .first();
  if (!consumed) throw new HttpError(400, "验证码无效或已过期");
  const user = await findOrCreateUser(
    env,
    data.email,
    data.email.split("@")[0],
  );
  await claimVisitor(env, visitor, user.id);
  const mobile =
    new URL(request.url).pathname === "/api/auth/mobile/email/verify";
  const credential = await issueSession(request, env, user.id, mobile);
  const response = json({
    user: publicUser(user),
    ...(mobile
      ? { token: credential, expiresAt: Date.now() + sessionLifetime }
      : {}),
  });
  if (!mobile) response.headers.append("Set-Cookie", credential);
  return response;
}
function googleCallbackUrl(env: Env) {
  return `${env.APP_ORIGIN}/api/auth/google/callback`;
}
async function googleStart(
  request: Request,
  env: Env,
  visitor: string,
  user: UserRow | null,
) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)
    throw new HttpError(503, "Google 登录尚未配置");
  const state = randomHex(32);
  await env.DB.prepare(
    "INSERT INTO auth_oauth_states(state_hash,visitor_id,link_user_id,expires) VALUES(?,?,?,?)",
  )
    .bind(await hash(state), visitor, user?.id ?? null, Date.now() + 600000)
    .run();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", googleCallbackUrl(env));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  const response = new Response(null, {
    status: 302,
    headers: { Location: url.toString() },
  });
  response.headers.append(
    "Set-Cookie",
    cookie(request, stateCookie, state, 600, "Lax"),
  );
  return response;
}
async function googleCallback(request: Request, env: Env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)
    throw new HttpError(503, "Google 登录尚未配置");
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (
    !state ||
    !/^[a-f0-9]{64}$/.test(state) ||
    state !== cookieValue(request, stateCookie) ||
    !code
  )
    throw new HttpError(400, "Google 登录验证失败");
  const used = await env.DB.prepare(
    "DELETE FROM auth_oauth_states WHERE state_hash=? AND expires>? RETURNING visitor_id,link_user_id",
  )
    .bind(await hash(state), Date.now())
    .first<{ visitor_id: string; link_user_id: string | null }>();
  if (!used) throw new HttpError(400, "Google 登录已过期");
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: googleCallbackUrl(env),
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!tokenResponse.ok) throw new HttpError(400, "Google 登录未完成");
  const token = (await tokenResponse.json()) as { access_token?: string };
  if (!token.access_token) throw new HttpError(400, "Google 登录未完成");
  const infoResponse = await fetch(
    "https://openidconnect.googleapis.com/v1/userinfo",
    {
      headers: { Authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!infoResponse.ok) throw new HttpError(400, "无法读取 Google 账号");
  const info = (await infoResponse.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
    hd?: string;
  };
  if (!info.sub || !info.email || !info.email_verified)
    throw new HttpError(400, "Google 邮箱尚未验证");
  const email = emailSchema.parse(info.email);
  const picture =
    info.picture &&
    /^https:\/\/lh3\.googleusercontent\.com\//.test(info.picture)
      ? info.picture
      : undefined;
  const existing = await env.DB.prepare(
    "SELECT user_id FROM auth_identities WHERE provider='google' AND subject=?",
  )
    .bind(info.sub)
    .first<{ user_id: string }>();
  let user: UserRow;
  if (existing) {
    if (used.link_user_id && existing.user_id !== used.link_user_id)
      throw new HttpError(409, "Google 账号已关联其他用户");
    user = requireUser(await userById(env, existing.user_id));
  } else if (used.link_user_id) {
    user = requireUser(await userById(env, used.link_user_id));
    if (user.email !== email)
      throw new HttpError(409, "Google 邮箱与当前账号不一致");
    await env.DB.prepare(
      "INSERT OR IGNORE INTO auth_identities(provider,subject,user_id) VALUES('google',?,?)",
    )
      .bind(info.sub, user.id)
      .run();
    const linked = await env.DB.prepare(
      "SELECT user_id FROM auth_identities WHERE provider='google' AND subject=?",
    )
      .bind(info.sub)
      .first<{ user_id: string }>();
    if (linked?.user_id !== user.id)
      throw new HttpError(409, "Google 账号已关联其他用户");
  } else if (email.endsWith("@gmail.com") || (info.hd && info.email_verified)) {
    user = await findOrCreateUser(
      env,
      email,
      info.name ?? email.split("@")[0],
      { sub: info.sub, picture },
    );
  } else {
    const response = new Response(null, {
      status: 302,
      headers: { Location: `${env.APP_ORIGIN}/?authError=email-verify` },
    });
    response.headers.append(
      "Set-Cookie",
      cookie(request, stateCookie, "", 0, "Lax"),
    );
    return response;
  }
  if (picture) {
    await env.DB.prepare(
      "UPDATE users SET google_picture=?,updated_at=? WHERE id=?",
    )
      .bind(picture, Date.now(), user.id)
      .run();
  }
  await claimVisitor(env, used.visitor_id, user.id);
  const response = new Response(null, {
    status: 302,
    headers: { Location: `${env.APP_ORIGIN}/?profile=1` },
  });
  response.headers.append(
    "Set-Cookie",
    await issueSession(request, env, user.id),
  );
  response.headers.append(
    "Set-Cookie",
    cookie(request, stateCookie, "", 0, "Lax"),
  );
  return response;
}
async function uploadAvatar(request: Request, env: Env, user: UserRow) {
  const type = request.headers.get("content-type")?.split(";")[0];
  if (!type || !["image/png", "image/jpeg", "image/webp"].includes(type))
    throw new HttpError(400, "请选择 PNG、JPEG 或 WebP 图片");
  const bytes = await readBody(request, 2 * 1024 * 1024);
  const valid =
    type === "image/png"
      ? bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47
      : type === "image/jpeg"
        ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        : String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
          String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  if (!valid) throw new HttpError(400, "图片格式无效");
  const key = `avatars/${user.id}/${crypto.randomUUID()}`;
  await env.AUDIO.put(key, bytes, { httpMetadata: { contentType: type } });
  await env.DB.prepare("UPDATE users SET avatar_key=?,updated_at=? WHERE id=?")
    .bind(key, Date.now(), user.id)
    .run();
  if (user.avatar_key) await env.AUDIO.delete(user.avatar_key);
  return json({ avatarUrl: "/api/profile/avatar" });
}
export async function authRoute(
  request: Request,
  env: Env,
  visitor: string,
  user: UserRow | null,
) {
  const path = new URL(request.url).pathname;
  const method = request.method;
  if (path === "/api/auth/session" && method === "GET")
    return json({
      user: user ? publicUser(user) : null,
      emailEnabled: !!env.EMAIL && !!env.AUTH_EMAIL_FROM,
      googleEnabled: !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET,
    });
  if (
    ["/api/auth/email/start", "/api/auth/mobile/email/start"].includes(path) &&
    method === "POST"
  )
    return sendCode(request, env);
  if (
    ["/api/auth/email/verify", "/api/auth/mobile/email/verify"].includes(
      path,
    ) &&
    method === "POST"
  )
    return verifyCode(request, env, visitor);
  if (path === "/api/auth/google" && method === "GET")
    return googleStart(request, env, visitor, user);
  if (path === "/api/auth/google/callback" && method === "GET")
    return googleCallback(request, env);
  if (path === "/api/auth/logout" && method === "POST") {
    const token =
      /^Bearer ([a-f0-9]{64})$/.exec(
        request.headers.get("authorization") ?? "",
      )?.[1] ?? cookieValue(request, authCookie);
    if (token && /^[a-f0-9]{64}$/.test(token))
      await env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash=?")
        .bind(await hash(token))
        .run();
    const response = json({ ok: true });
    response.headers.append("Set-Cookie", cookie(request, authCookie, "", 0));
    return response;
  }
  if (path === "/api/profile" && method === "GET")
    return json({ user: publicUser(requireUser(user)) });
  if (path === "/api/profile" && method === "PATCH") {
    const current = requireUser(user);
    const data = profileSchema.parse(await readJson(request));
    await env.DB.prepare(
      "UPDATE users SET alias=?,description=?,updated_at=? WHERE id=?",
    )
      .bind(data.alias, data.description, Date.now(), current.id)
      .run();
    return json({ user: publicUser((await userById(env, current.id))!) });
  }
  if (path === "/api/profile/avatar" && method === "PUT")
    return uploadAvatar(request, env, requireUser(user));
  if (path === "/api/profile/avatar" && method === "GET") {
    const current = requireUser(user);
    if (!current.avatar_key) throw new HttpError(404, "头像不存在");
    const object = await env.AUDIO.get(current.avatar_key);
    if (!object) throw new HttpError(404, "头像不存在");
    return new Response(object.body, {
      headers: {
        "Content-Type":
          object.httpMetadata?.contentType ?? "application/octet-stream",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  throw new HttpError(404, "接口不存在");
}
