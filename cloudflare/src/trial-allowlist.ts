interface TrialIdentityEnv {
  SESSION_SECRET: string;
  TRIAL_TEST_IP_HASHES?: string;
}

/** Matches the existing trial proof and IP budget identity; never stores raw IPs. */
export async function ipKey(request: Request, env: Pick<TrialIdentityEnv, "SESSION_SECRET">) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(request.headers.get("cf-connecting-ip") ?? "local"),
  );
  return Array.from(new Uint8Array(bytes), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}

/** Cloudflare supplies this header in production. Never trust forwarded IP headers. */
export async function isTrialTester(request: Request, env: TrialIdentityEnv) {
  if (!env.TRIAL_TEST_IP_HASHES || !request.headers.get("cf-connecting-ip"))
    return false;
  const allowed = env.TRIAL_TEST_IP_HASHES.split(/[\s,]+/).filter((value) =>
    /^[a-f0-9]{64}$/.test(value),
  );
  if (!allowed.length) return false;
  return allowed.includes(await ipKey(request, env));
}
