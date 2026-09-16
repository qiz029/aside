import { useEffect, useRef, useState } from "react";

/** Polls only while the debug panel is open; does not start any audio device. */
export function VoiceDiagnostics({ read }: { read: () => Promise<unknown> }) {
  const latest = useRef(read);
  latest.current = read;
  const [snapshot, setSnapshot] = useState<unknown>(null);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await latest.current();
        if (!stopped) setSnapshot(value);
      } catch {
        if (!stopped) setSnapshot({ diagnosticsUnavailable: true });
      } finally {
        if (!stopped) timer = setTimeout(poll, 1000);
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
  return (
    <section aria-label="Voice diagnostics">
      <p>
        Voice diagnostics · Metadata stays in this tab. Speak and watch
        microphone RMS, frame count and WebRTC audio energy.
      </p>
      <pre className="debug">
        {JSON.stringify(
          {
            bundle: document.querySelector<HTMLScriptElement>(
              'script[type="module"]',
            )?.src,
            session: snapshot,
          },
          null,
          2,
        )}
      </pre>
    </section>
  );
}
