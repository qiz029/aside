/** Optional localhost-only slow-upload proxy for native background-cancellation tests. */
import http from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const target = `http://127.0.0.1:${Number(process.env.TARGET_PORT ?? 4313)}`;
const switchPath = join(tmpdir(), "aside-upload-throttle");
const server = http.createServer(async (req, res) => {
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (
      req.method === "PUT" &&
      req.url.includes("/part?") &&
      existsSync(switchPath)
    ) {
      console.log("Upload part delayed for cancellation check");
      await new Promise((resolve) => setTimeout(resolve, 20000));
    }
    if (abort.signal.aborted) {
      console.log("Cancelled part was not forwarded");
      return;
    }
    const headers = { ...req.headers };
    delete headers.host;
    delete headers["content-length"];
    const response = await fetch(target + req.url, {
      method: req.method,
      headers,
      signal: abort.signal,
      body: ["GET", "HEAD"].includes(req.method)
        ? undefined
        : Buffer.concat(chunks),
    });
    const outputHeaders = Object.fromEntries(response.headers);
    // fetch already decoded the response; native clients must not decode it twice.
    delete outputHeaders["content-encoding"];
    delete outputHeaders["content-length"];
    delete outputHeaders["transfer-encoding"];
    res.writeHead(response.status, outputHeaders);
    res.end(Buffer.from(await response.arrayBuffer()));
    if (req.url.includes("/uploads"))
      console.log(req.method, req.url, response.status);
  } catch {
    if (!res.destroyed) {
      res.writeHead(502);
      res.end("Local upload proxy interrupted");
    }
  }
});
server.listen(Number(process.env.PORT ?? 4311), "127.0.0.1", () => {
  console.log(
    "Local upload proxy ready; delay enabled while this file exists:",
    switchPath,
  );
});
