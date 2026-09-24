import type { Env } from "./env.js";
import { cleanupDeletedEpisode } from "./space.js";
import { revokeApple } from "./apple.js";
import { HttpError } from "./http.js";
export const AI_CONSENT_VERSION = "2026-09-21";
export async function requireMobileConsent(
  request: Request,
  env: Env,
  user: string,
) {
  if (!request.headers.has("authorization")) return;
  const consent = await env.DB.prepare(
    "SELECT version FROM account_consents WHERE user_id=?",
  )
    .bind(user)
    .first<{ version: string }>();
  if (consent?.version !== AI_CONSENT_VERSION)
    throw new HttpError(
      403,
      "请先同意 AI 数据处理说明 / Please review AI data processing first",
    );
}
/** Every step is retryable. The account is disabled before any remote cleanup. */
export async function cleanupAccount(env: Env, id: string) {
  const user = await env.DB.prepare(
    "SELECT email FROM users WHERE id=? AND deleted_at IS NOT NULL",
  )
    .bind(id)
    .first<{ email: string }>();
  if (!user) return;
  const sessions = await env.DB.prepare(
    "SELECT session_id FROM voice_usage WHERE owner_id=? AND finalized=0",
  )
    .bind(id)
    .all<{ session_id: string }>();
  for (const session of sessions.results)
    await env.LIVE.get(env.LIVE.idFromName(id)).close(session.session_id);
  const identities = await env.DB.prepare(
    "SELECT refresh_token,client_id FROM auth_identities WHERE user_id=? AND provider='apple'",
  )
    .bind(id)
    .all<{ refresh_token: string | null; client_id: string }>();
  for (const identity of identities.results) {
    if (identity.refresh_token)
      await revokeApple(env, identity.refresh_token, identity.client_id);
  }
  const uploads = await env.DB.prepare(
    "SELECT id,upload_id,object_key FROM uploads WHERE owner_id=? AND state='pending'",
  )
    .bind(id)
    .all<{ id: string; upload_id: string; object_key: string }>();
  for (const upload of uploads.results) {
    try {
      await env.AUDIO.resumeMultipartUpload(
        upload.object_key,
        upload.upload_id,
      ).abort();
    } catch (error) {
      // A previous attempt may have aborted R2 before persisting its acknowledgement.
      if (
        !(error instanceof Error) ||
        !/NoSuchUpload|specified multipart upload does not exist/i.test(
          error.message,
        )
      )
        throw error;
    }
    await env.DB.prepare(
      "UPDATE uploads SET state='aborted' WHERE id=? AND state='pending'",
    )
      .bind(upload.id)
      .run();
  }
  const objects = await env.DB.prepare(
    "SELECT object_key FROM uploads WHERE owner_id=?",
  )
    .bind(id)
    .all<{ object_key: string }>();
  for (const object of objects.results)
    await env.AUDIO.delete(object.object_key);
  await env.DB.prepare(
    "UPDATE episodes SET deleted_at=COALESCE(deleted_at,?) WHERE owner_id=?",
  )
    .bind(Date.now(), id)
    .run();
  const episodes = await env.DB.prepare(
    "SELECT id FROM episodes WHERE owner_id=?",
  )
    .bind(id)
    .all<{ id: string }>();
  for (const episode of episodes.results)
    await cleanupDeletedEpisode(env, episode.id);
  let cursor: string | undefined;
  do {
    const page = await env.AUDIO.list({ prefix: `avatars/${id}/`, cursor });
    if (page.objects.length)
      await env.AUDIO.delete(page.objects.map((x) => x.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM checkpoints WHERE owner_id=?").bind(id),
    env.DB.prepare("DELETE FROM voice_usage WHERE owner_id=?").bind(id),
    env.DB.prepare(
      "DELETE FROM question_usage WHERE owner_id=? OR account_id=?",
    ).bind(id, id),
    env.DB.prepare("DELETE FROM episodes WHERE owner_id=?").bind(id),
    env.DB.prepare("DELETE FROM uploads WHERE owner_id=?").bind(id),
    env.DB.prepare("DELETE FROM auth_sessions WHERE user_id=?").bind(id),
    env.DB.prepare("DELETE FROM auth_identities WHERE user_id=?").bind(id),
    env.DB.prepare("DELETE FROM account_consents WHERE user_id=?").bind(id),
    env.DB.prepare("DELETE FROM apple_challenges WHERE user_id=?").bind(id),
    env.DB.prepare("DELETE FROM auth_mobile_grants WHERE user_id=?").bind(id),
    env.DB.prepare("DELETE FROM auth_oauth_states WHERE link_user_id=?").bind(
      id,
    ),
    env.DB.prepare("DELETE FROM auth_codes WHERE email=?").bind(user.email),
    env.DB.prepare("DELETE FROM trial_proofs WHERE owner=?").bind(id),
    env.DB.prepare("DELETE FROM trial_leases WHERE owner=?").bind(id),
    env.DB.prepare("DELETE FROM trial_breakers WHERE owner=?").bind(id),
    env.DB.prepare("DELETE FROM users WHERE id=?").bind(id),
  ]);
}
