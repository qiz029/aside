/** The deadline belongs to the HTTP handshake, not the upgraded socket. */
export async function fetchWebSocketUpgrade(
  url: string,
  headers: HeadersInit,
  timeoutMs = 5000,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(
    () => abort.abort(Error("WebSocket handshake timed out")),
    timeoutMs,
  );
  try {
    return await fetcher(url, { headers, signal: abort.signal });
  } finally {
    // Workers keep the fetch signal attached after a 101 response. Leaving a
    // timeout alive here closes a healthy WebSocket a few seconds later.
    clearTimeout(timer);
  }
}
