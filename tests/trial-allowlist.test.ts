import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { ipKey, isTrialTester } from "../cloudflare/src/trial-allowlist.js";

const secret = "test-session-secret";
const ip = "192.0.2.10";
const hash = (value: string) => createHmac("sha256", secret).update(value).digest("hex");
const request = (headers: Record<string, string> = {}) => new Request("https://aside.test/api/trial", { headers });

test("given a configured IP hash, only the exact Cloudflare client IP is exempt", async () => {
  const env = { SESSION_SECRET: secret, TRIAL_TEST_IP_HASHES: ` ${hash("192.0.2.11")},\n${hash(ip)} ` };
  assert.equal(await ipKey(request({ "cf-connecting-ip": ip }), env), hash(ip));
  assert.equal(await isTrialTester(request({ "cf-connecting-ip": ip }), env), true);
  assert.equal(await isTrialTester(request({ "cf-connecting-ip": "192.0.2.12" }), env), false);
  assert.equal(await isTrialTester(request({ "x-forwarded-for": ip, "x-real-ip": ip }), env), false);
});

test("given absent or invalid configuration, requests retain normal quotas", async () => {
  const req = request({ "cf-connecting-ip": ip });
  for (const configured of [undefined, "", " , \n ", ip, hash(ip).slice(1), `${hash(ip)}extra`]) {
    assert.equal(await isTrialTester(req, { SESSION_SECRET: secret, TRIAL_TEST_IP_HASHES: configured }), false);
  }
  assert.equal(await isTrialTester(req, { SESSION_SECRET: "rotated-secret", TRIAL_TEST_IP_HASHES: hash(ip) }), false);
});

test("given no Cloudflare client IP, the local quota key cannot become an exemption", async () => {
  const env = { SESSION_SECRET: secret, TRIAL_TEST_IP_HASHES: hash("local") };
  assert.equal(await ipKey(request(), env), hash("local"));
  assert.equal(await isTrialTester(request(), env), false);
  assert.equal(await isTrialTester(request({ "cf-connecting-ip": "" }), env), false);
});
