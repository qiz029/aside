import { useEffect, useRef, useState } from "react";
import type { ListeningSession } from "./listening-session";
type Snapshot = Awaited<ReturnType<ListeningSession["voiceDiagnostics"]>>;

/** Polls only while the debug panel is open; does not start any audio device. */
export function VoiceDiagnostics({ read }: { read: () => Promise<Snapshot> }) {
  const latest = useRef(read);
  latest.current = read;
  const [snapshot, setSnapshot] = useState<Snapshot | { diagnosticsUnavailable: true } | null>(null);
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
  const recognition = snapshot && "recognition" in snapshot ? snapshot.recognition : undefined;
  return (
    <section aria-label="Voice diagnostics">
      <p>
        Voice diagnostics · This extra trace stays in memory in this tab, outside
        checkpoints and server logs. It resets on reload, episode change or a new
        voice connection. Normal accepted conversation history is separate.
      </p>
      {recognition && <div>
        <p><strong>Live heard (current connection, last 4,000 characters)</strong></p>
        <blockquote style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {recognition.liveInputText || "No input transcript received yet."}
        </blockquote>
        <p><strong>Conversation input</strong></p>
        <blockquote>{recognition.conversationInput || "No input in the current turn."}</blockquote>
        <p><strong>Sent for intent classification</strong></p>
        <blockquote>{recognition.submittedText || "No request sent in the current turn."}</blockquote>
        <p>Input gate: {recognition.lastInputDisposition}</p>
      </div>}
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
