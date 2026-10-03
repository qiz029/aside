import {
  defaultVoiceFeatures,
  type VoiceFeatures,
} from "@aside/engine/contracts";

export type FeatureContext = Record<string, string | number | boolean>;
export interface FlagshipBinding {
  getBooleanValue(
    key: string,
    fallback: boolean,
    context?: FeatureContext,
  ): Promise<boolean>;
  getStringValue(
    key: string,
    fallback: string,
    context?: FeatureContext,
  ): Promise<string>;
}

/** Business dimensions can be added here by trusted server code. Never accept
 * arbitrary client JSON as the targeting context or as account entitlements. */
export function featureContext(
  request: Request,
  owner: string,
  accountId: string | null,
  environment: string,
  attributes: FeatureContext = {},
): FeatureContext {
  const header = (key: string) =>
    (request.headers.get(key) ?? "").slice(0, 100);
  const platform = header("x-aside-platform");
  const build = header("x-aside-app-build");
  const country = (request as Request & { cf?: { country?: string } }).cf
    ?.country;
  return {
    ...attributes,
    targetingKey: owner,
    userId: owner,
    authenticated: !!accountId,
    audience: accountId ? "account" : "trial",
    environment,
    // Client hints are useful for compatibility/rollout, never authorization.
    platform: ["web", "ios", "android"].includes(platform)
      ? platform
      : "unknown",
    locale:
      header("x-aside-locale") || header("accept-language").split(/[,;]/)[0],
    appVersion: header("x-aside-app-version"),
    ...(build && /^\d{1,9}$/.test(build) ? { appBuild: Number(build) } : {}),
    country: country ?? "unknown",
  };
}

/** Native binding evaluation only, with no cross-user decision cache. A bounded
 * wait prevents a flag outage from holding up a voice connection. */
export async function voiceFeatures(
  env: {
    FLAGS?: FlagshipBinding;
    AI_ENABLED?: string;
    GEMINI_API_KEY?: string;
  },
  context: FeatureContext,
): Promise<VoiceFeatures> {
  const defaults = defaultVoiceFeatures();
  const flags = env.FLAGS;
  if (!flags) return { ...defaults, liveEnabled: env.AI_ENABLED !== "false" };
  const read = async <T>(
    key: string,
    fallback: T,
    evaluate: () => Promise<T>,
  ): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        Promise.resolve().then(evaluate),
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(Error("timeout")), 250);
        }),
      ]);
      return typeof value === typeof fallback ? value : fallback;
    } catch {
      console.warn(`Feature flag evaluation unavailable: ${key}`);
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  };
  const [enabled, eligible, preferred] = await Promise.all([
    read("live_enabled", true, () =>
      flags.getBooleanValue("live_enabled", true, context),
    ),
    read("gemini_live_enabled", false, () =>
      flags.getBooleanValue("gemini_live_enabled", false, context),
    ),
    read("voice_provider", "openai", () =>
      flags.getStringValue("voice_provider", "openai", context),
    ),
  ]);
  return {
    ...defaults,
    liveEnabled: env.AI_ENABLED !== "false" && enabled,
    geminiEligible: eligible,
    preferredProvider: preferred === "gemini" ? "gemini" : "openai",
    availableProviders:
      eligible && env.GEMINI_API_KEY ? ["openai", "gemini"] : ["openai"],
    provider:
      eligible && preferred === "gemini" && env.GEMINI_API_KEY
        ? "gemini"
        : "openai",
  };
}
