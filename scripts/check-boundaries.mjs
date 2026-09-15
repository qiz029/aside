import { readdir, readFile } from "node:fs/promises";
async function files(dir) {
  return (
    await Promise.all(
      (await readdir(dir, { withFileTypes: true })).map((e) =>
        e.isDirectory() ? files(`${dir}/${e.name}`) : `${dir}/${e.name}`,
      ),
    )
  ).flat();
}
const errors = [];
for (const path of await files("engine/src")) {
  const s = await readFile(path, "utf8");
  if (/from\s+['"](?:node:|react|fastify|openai|.*backend|.*frontend)/.test(s))
    errors.push(path);
}
for (const path of await files("frontend/src")) {
  const s = await readFile(path, "utf8");
  if (
    /from\s+['"](?:node:|openai|@aside\/engine\/server|.*backend\/src)/.test(s)
  )
    errors.push(path);
}
for (const path of await files("cloudflare/src")) {
  const s = await readFile(path, "utf8");
  if (
    /from\s+['"](?:node:(?:fs|child_process|sqlite)|.*backend\/src\/(?:provider|enrichment|jobs|media|store|app)(?:\.js)?['"])/.test(
      s,
    )
  )
    errors.push(path);
}
for (const path of [
  "backend/src/app.ts",
  "backend/src/jobs.ts",
  "backend/src/provider.ts",
  "backend/src/enrichment.ts",
]) {
  const source = await readFile(path, "utf8");
  if (/from\s+['"]node:(?:fs|path)/.test(source)) errors.push(path);
}
for (const path of await files("player-runtime/src")) {
  const source = await readFile(path, "utf8");
  if (
    /from\s+['"](?:react|expo|node:|.*frontend|.*backend|.*mobile)/.test(
      source,
    ) ||
    /\b(?:window\.|document\.|MediaStream|HTMLAudioElement)\b/.test(source)
  )
    errors.push(path);
}
if (errors.length)
  throw Error(`Forbidden module dependency: ${errors.join(", ")}`);
console.log("Module boundaries passed");
