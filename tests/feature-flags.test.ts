import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultVoiceFeatures } from "@aside/engine/contracts";
import {
  featureContext,
  voiceFeatures,
  type FlagshipBinding,
} from "../cloudflare/src/feature-flags.js";

test("targeting preserves server identity and business attributes, not spoofed account headers", () => {
  const request = new Request("https://aside.test", {
    headers: {
      "x-aside-platform": "ios",
      "x-aside-app-version": "0.2.0",
      "x-aside-app-build": "4",
      "x-aside-locale": "zh-CN",
      "x-aside-user-id": "victim",
      "x-aside-plan": "pro",
      "cf-ipcountry": "XX",
    },
  });
  Object.defineProperty(request, "cf", { value: { country: "US" } });
  const context = featureContext(
    request,
    "account-1",
    "account-1",
    "production",
    {
      podcastLanguage: "zh",
      targetingKey: "spoof",
      authenticated: false,
    },
  );
  assert.deepEqual(context, {
    podcastLanguage: "zh",
    targetingKey: "account-1",
    userId: "account-1",
    authenticated: true,
    audience: "account",
    environment: "production",
    platform: "ios",
    locale: "zh-CN",
    appVersion: "0.2.0",
    appBuild: 4,
    country: "US",
  });
});

test("invalid client dimensions are bounded and never invent a numeric build", () => {
  const context = featureContext(
    new Request("https://aside.test", {
      headers: {
        "x-aside-platform": "admin",
        "x-aside-app-build": "Infinity",
        "x-aside-app-version": "v".repeat(200),
        "accept-language": "en-US,en;q=0.9",
      },
    }),
    "visitor-1",
    null,
    "development",
  );
  assert.equal(context.targetingKey, "visitor-1");
  assert.equal(context.platform, "unknown");
  assert.equal(context.appBuild, undefined);
  assert.equal(context.appVersion.toString().length, 100);
  assert.equal(context.locale, "en-US");
  assert.equal(context.authenticated, false);
});

test("missing binding and provider failures preserve existing voice and keep Gemini unavailable", async () => {
  assert.deepEqual(await voiceFeatures({}, {}), defaultVoiceFeatures());
  const broken: FlagshipBinding = {
    async getBooleanValue() {
      throw Error("provider failure");
    },
    async getStringValue() {
      throw Error("provider failure");
    },
  };
  assert.deepEqual(
    await voiceFeatures({ FLAGS: broken }, {}),
    defaultVoiceFeatures(),
  );
  assert.equal(
    (await voiceFeatures({ AI_ENABLED: "false" }, {})).liveEnabled,
    false,
  );
});

test("targeted decisions are not shared across users and cannot enable missing Gemini transport", async () => {
  const flags: FlagshipBinding = {
    async getBooleanValue(key, fallback, context) {
      return key === "live_enabled" ? context?.userId === "allowed" : true;
    },
    async getStringValue() {
      return "gemini";
    },
  };
  const enabled = await voiceFeatures({ FLAGS: flags }, { userId: "allowed" });
  assert.equal(enabled.liveEnabled, true);
  assert.equal(enabled.geminiEligible, true);
  assert.equal(enabled.preferredProvider, "gemini");
  assert.equal(enabled.provider, "openai");
  assert.deepEqual(enabled.availableProviders, ["openai"]);
  assert.equal(
    (await voiceFeatures({ FLAGS: flags }, { userId: "denied" })).liveEnabled,
    false,
  );
  assert.equal(
    (
      await voiceFeatures(
        { FLAGS: flags, AI_ENABLED: "false" },
        { userId: "allowed" },
      )
    ).liveEnabled,
    false,
  );
});

test("unknown provider and stalled evaluations fall back within the connection budget", async () => {
  const flags: FlagshipBinding = {
    async getBooleanValue() {
      return new Promise(() => {});
    },
    async getStringValue() {
      return "unsupported-provider";
    },
  };
  const started = Date.now();
  assert.deepEqual(
    await voiceFeatures({ FLAGS: flags }, {}),
    defaultVoiceFeatures(),
  );
  assert.ok(Date.now() - started < 1500);
});
