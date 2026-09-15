/** Test-fixture CLI: node mobile/tests/checkpoint.mjs email [positionMs]. */
const base = `http://127.0.0.1:${Number(process.env.PORT ?? 4311)}/api`;
const email = process.argv[2];
if (!email?.endsWith("@example.com"))
  throw Error("Use a local example.com fixture account");
let token;
async function req(path, method = "GET", body) {
  const r = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw Error(`${path}: ${r.status}`);
  return data;
}
await req("/auth/mobile/email/start", "POST", { email });
token = (
  await req("/auth/mobile/email/verify", "POST", { email, code: "12345678" })
).token;
let cp = await req("/episodes/mobile-sample/checkpoint");
if (process.argv[3] !== undefined)
  cp = await req("/episodes/mobile-sample/checkpoint", "PUT", {
    ...cp,
    positionMs: Number(process.argv[3]),
    resumeMs: undefined,
  });
console.log(JSON.stringify(cp));
