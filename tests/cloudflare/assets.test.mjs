import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

/**
 * The Worker only sees the routes wrangler.jsonc hands it, and the static asset
 * binding decides what an unknown path returns. Both live in configuration, so
 * this test drives a real asset directory through the same options the deployed
 * Worker uses: a route outside `run_worker_first` would silently ship SEO
 * defaults, and `single-page-application` would turn every typo into a 200.
 */
let mf;
const origin = "https://aside.test";

/** wrangler.jsonc is JSON with comments and trailing commas; read it as text. */
function stringValue(text, key) {
  const match = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(text);
  assert.ok(match, `${key} missing from wrangler config`);
  return match[1];
}
function stringList(text, key) {
  const match = new RegExp(`"${key}"\\s*:\\s*\\[([^\\]]*)\\]`).exec(text);
  assert.ok(match, `${key} missing from wrangler config`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}
function assetsConfig(text) {
  return {
    directory: stringValue(text, "directory"),
    notFoundHandling: stringValue(text, "not_found_handling"),
    runWorkerFirst: /"run_worker_first"\s*:\s*true/.test(text),
  };
}

before(async () => {
  const dev = await readFile("wrangler.jsonc", "utf8");
  const production = await readFile("wrangler.production.jsonc", "utf8");
  const assets = assetsConfig(production);
  // Development and production must route the same paths, or a fix verified
  // locally would not be the one that ships.
  assert.deepEqual(assetsConfig(dev), assets);
  assert.equal(assets.notFoundHandling, "none");
  assert.ok(
    assets.runWorkerFirst,
    "every route must reach the Worker or SEO metadata is silently skipped",
  );
  const bundle = await build({
    entryPoints: ["tests/cloudflare/worker.mjs"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*"],
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: stringValue(production, "compatibility_date"),
      compatibilityFlags: stringList(production, "compatibility_flags"),
      d1Databases: ["DB"],
      r2Buckets: ["AUDIO"],
      // Same shape wrangler derives from `assets` in wrangler.jsonc.
      assets: {
        directory: assets.directory,
        binding: "ASSETS",
        run_worker_first: assets.runWorkerFirst,
        routerConfig: { has_user_worker: true },
        assetConfig: { not_found_handling: assets.notFoundHandling },
      },
      bindings: {
        APP_ORIGIN: origin,
        SESSION_SECRET: "local-test-secret-at-least-32-characters",
        ALLOW_UPLOADS: "false",
      },
    }),
  );
  const db = await mf.getD1Database("DB");
  const dir = "cloudflare/migrations";
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const sql = (
    await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")))
  ).join("\n");
  for (const statement of sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean))
    await db.prepare(statement).run();
});

after(async () => {
  await mf?.dispose();
});

async function get(path) {
  return mf.dispatchFetch(origin + path, { redirect: "manual" });
}

test("configured asset routing serves the SEO routes, assets and real 404s", async () => {
  const home = await get("/");
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /<link rel="canonical" href="https:\/\/asidefm\.com\/" \/>/);
  assert.ok(html.includes("<div id="), "the built shell is what gets injected");

  const chinese = await get("/zh");
  assert.equal(chinese.status, 200);
  assert.match(await chinese.text(), /<html lang="zh-CN">/);

  const sitemap = await get("/sitemap.xml");
  assert.equal(sitemap.status, 200);
  assert.equal(sitemap.headers.get("content-type"), "application/xml");

  const space = await get("/space");
  assert.equal(space.status, 200);
  assert.equal(space.headers.get("x-robots-tag"), "noindex, nofollow");

  const missingEpisode = await get("/episodes/does-not-exist");
  assert.equal(missingEpisode.status, 404);

  // Outside the Worker: an unknown path must not fall back to the app shell.
  const unknown = await get("/no-such-page");
  assert.equal(unknown.status, 404, "unknown paths must not answer 200");

  const mark = await get("/aside-mark.svg");
  assert.equal(mark.status, 200);
  assert.equal(mark.headers.get("content-type"), "image/svg+xml");

  const robots = await get("/robots.txt");
  assert.equal(robots.status, 200);
  assert.match(await robots.text(), /Sitemap: https:\/\/asidefm\.com\/sitemap\.xml/);

  const bundle = (await readdir("frontend/dist/assets")).find((f) =>
    f.endsWith(".js"),
  );
  const asset = await get(`/assets/${bundle}`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type"), /javascript/);
});
