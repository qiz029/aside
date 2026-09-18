import type { ListeningSession } from "@aside/player-runtime/listening-session";

/** Local simulator evidence only. Callers must opt in with the guarded test build. */
export function observeAcceptance(
  session: ListeningSession,
  base: string,
  platform: string,
  player: () => { playing: boolean; positionMs: number; volume: number },
) {
  if (!/^http:\/\/(127\.0\.0\.1|localhost|10\.0\.2\.2):\d+$/.test(base))
    throw Error("Acceptance evidence must stay on the local fixture");
  let pending = false;
  const timer = setInterval(async () => {
    if (pending) return;
    pending = true;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 2000);
    try {
      const snapshot = session.getSnapshot();
      await fetch(`${base}/__fixture/device`, {
        method: "POST",
        signal: abort.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform,
          at: Date.now(),
          player: player(),
          mode: snapshot.state.mode,
          interruption: snapshot.state.interruption,
          resumeSeconds: snapshot.resumeSeconds,
          busy: snapshot.busy,
          history: snapshot.history,
          diagnostics: await session.voiceDiagnostics(),
        }),
      });
    } catch {
      /* The optional observer must not change player behavior. */
    } finally {
      clearTimeout(timeout);
      pending = false;
    }
  }, 200);
  return () => clearInterval(timer);
}
