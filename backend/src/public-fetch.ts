/** Fetch public podcast resources without credentials or unchecked redirect targets. */
export function publicUrl(value: string) {
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["80", "443"].includes(url.port)) ||
    !url.hostname.includes(".") ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname) ||
    /^[\d.]+$/.test(url.hostname) ||
    url.hostname.includes(":")
  )
    throw Error("Only public HTTP podcast URLs are supported");
  return url;
}
export function privateAddress(ip: string) {
  if (ip.includes(":"))
    return !/^2[0-9a-f]{3}:/i.test(ip) || /^2001:(?:db8|0):/i.test(ip);
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && [0, 168].includes(b)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && [18, 19, 51].includes(b)) ||
    (a === 203 && b === 0)
  );
}
export async function publicFetch(
  value: string,
  init: RequestInit = {},
  transport = fetch,
  timeoutMs = 30000,
) {
  let url = publicUrl(value);
  const signal = AbortSignal.any([
    ...(init.signal ? [init.signal] : []),
    AbortSignal.timeout(timeoutMs),
  ]);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const answers = await Promise.all(
      ["A", "AAAA"].map(async (type) => {
        const r = await transport(
          `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(url.hostname)}&type=${type}`,
          { headers: { Accept: "application/dns-json" }, signal },
        );
        if (!r.ok) throw Error("Cannot resolve podcast host");
        return (
          ((await r.json()) as { Answer?: { type: number; data: string }[] })
            .Answer ?? []
        );
      }),
    );
    const addresses = answers.flat().filter((a) => [1, 28].includes(a.type));
    if (!addresses.length || addresses.some((a) => privateAddress(a.data)))
      throw Error("Podcast host is not public");
    const response = await transport(url, {
      ...init,
      signal,
      credentials: "omit",
      redirect: "manual",
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw Error("Invalid podcast redirect");
      url = publicUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(`Podcast host returned HTTP ${response.status}`);
    }
    return response;
  }
  throw Error("Too many podcast redirects");
}
export async function boundedBody(response: Response, max: number) {
  if (Number(response.headers.get("content-length")) > max) {
    await response.body?.cancel();
    throw Error("Podcast resource is too large");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw Error("Podcast resource is too large");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
