import {
  createRemoteJWKSet,
  jwtVerify,
  SignJWT,
  importPKCS8,
  EncryptJWT,
  jwtDecrypt,
} from "jose";
import { z } from "zod";
import type { Env } from "./env.js";
import { HttpError } from "./http.js";

const keys = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));
export function appleEnabled(env: Env) {
  return !!(
    env.APPLE_CLIENT_IDS &&
    env.APPLE_TEAM_ID &&
    env.APPLE_KEY_ID &&
    env.APPLE_PRIVATE_KEY
  );
}
export function appleClient(env: Env, client: string) {
  if (!appleEnabled(env))
    throw new HttpError(
      503,
      "Apple 登录尚未配置 / Apple sign-in is not configured",
    );
  if (
    !env
      .APPLE_CLIENT_IDS!.split(",")
      .map((x) => x.trim())
      .includes(client)
  )
    throw new HttpError(400, "Invalid Apple client");
  return client;
}
async function clientSecret(env: Env, client: string) {
  appleClient(env, client);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: env.APPLE_KEY_ID! })
    .setIssuer(env.APPLE_TEAM_ID!)
    .setSubject(client)
    .setAudience("https://appleid.apple.com")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(
      await importPKCS8(env.APPLE_PRIVATE_KEY!.replace(/\\n/g, "\n"), "ES256"),
    );
}
async function encryptionKey(env: Env) {
  return new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`apple-refresh:${env.SESSION_SECRET}`),
    ),
  );
}
export async function protectAppleToken(env: Env, token: string) {
  return new EncryptJWT({ token })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .encrypt(await encryptionKey(env));
}
export async function validateApple(
  env: Env,
  client: string,
  code: string,
  nonce: string,
) {
  const response = await fetch("https://appleid.apple.com/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client,
      client_secret: await clientSecret(env, client),
      code,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw new HttpError(
      400,
      "Apple 登录已过期，请重试 / Please try Apple sign-in again",
    );
  const tokens = z
    .object({ id_token: z.string(), refresh_token: z.string().min(1) })
    .parse(await response.json());
  let claims;
  try {
    claims = (
      await jwtVerify(tokens.id_token, keys, {
        issuer: "https://appleid.apple.com",
        audience: client,
        algorithms: ["RS256"],
      })
    ).payload;
  } catch {
    throw new HttpError(400, "Invalid Apple identity");
  }
  if (
    !claims.sub ||
    claims.nonce !== nonce ||
    !(claims.email_verified === true || claims.email_verified === "true")
  )
    throw new HttpError(400, "Invalid Apple identity");
  return {
    subject: claims.sub,
    email: z.string().email().max(254).parse(claims.email).toLowerCase(),
    refresh: tokens.refresh_token,
  };
}
export async function revokeApple(env: Env, encrypted: string, client: string) {
  const { payload } = await jwtDecrypt(encrypted, await encryptionKey(env));
  const response = await fetch("https://appleid.apple.com/auth/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client,
      client_secret: await clientSecret(env, client),
      token: z.string().parse(payload.token),
      token_type_hint: "refresh_token",
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("Apple revocation unavailable");
}
