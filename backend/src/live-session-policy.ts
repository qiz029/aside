/** Application limits, independent of the provider's session lifetime. */
export function liveSessionPolicy(
  env: { ASIDE_LIVE_ACCOUNT_SESSION_SECONDS?: string },
  authenticated: boolean,
) {
  const raw = env.ASIDE_LIVE_ACCOUNT_SESSION_SECONDS?.trim();
  const seconds = authenticated && raw ? Number(raw) : 120;
  if (!Number.isInteger(seconds) || seconds < 120 || seconds > 3600)
    throw Error(
      "ASIDE_LIVE_ACCOUNT_SESSION_SECONDS must be an integer between 120 and 3600",
    );
  return { seconds, intentCalls: Math.ceil(seconds / 4) };
}

export const liveSessionExpired =
  "Voice session time limit reached. Please reconnect the microphone to keep talking.";
