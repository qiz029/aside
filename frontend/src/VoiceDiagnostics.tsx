import { useEffect, useRef, useState } from "react";
import type { ListeningSession } from "./listening-session";
type Snapshot = Awaited<ReturnType<ListeningSession["voiceDiagnostics"]>>;

/** Polls only while the debug panel is open; does not start any audio device. */
export function VoiceDiagnostics({ read }: { read: () => Promise<Snapshot> }) {
  const latest = useRef(read);
  latest.current = read;
  const [snapshot, setSnapshot] = useState<
    Snapshot | { diagnosticsUnavailable: true } | null
  >(null);
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
  const recognition =
    snapshot && "recognition" in snapshot ? snapshot.recognition : undefined;
  const session = snapshot && "status" in snapshot ? snapshot : undefined;
  return (
    <section className="voice-diagnostics" aria-label="Voice diagnostics">
      <header className="debug-heading">
        <h2>Voice diagnostics</h2>
        <span className="debug-status">
          Microphone: {session?.status ?? "…"}
        </span>
        <span className="debug-status">
          NDJSON: {session?.control.status ?? "…"}
        </span>
      </header>
      <p className="debug-note">
        Opening this panel does not start the microphone. Extra traces stay in
        this tab and reset on reload, episode change or a new voice connection;
        they are not saved to checkpoints or server logs. Accepted conversation
        history is separate.
      </p>
      {session?.error && <p className="debug-error">{session.error}</p>}
      {recognition && (
        <>
          <div className="debug-stages">
            <div className="debug-stage">
              <h3>1 · Live heard</h3>
              <p>Current connection · last 4,000 characters</p>
              <blockquote>
                {recognition.liveInputText ||
                  "No input transcript received yet."}
              </blockquote>
            </div>
            <div className="debug-stage">
              <h3>2 · Backend received</h3>
              <p>Input received through the sideband</p>
              <blockquote>
                {recognition.conversationInput ||
                  "No input in the current turn."}
              </blockquote>
            </div>
            <div className="debug-stage">
              <h3>3 · Backend classifying</h3>
              <p>Input submitted for an intent decision</p>
              <blockquote>
                {recognition.submittedText ||
                  "No classification started in this session."}
              </blockquote>
            </div>
          </div>
          {session?.spokenReply && (
            <div className="debug-stage">
              <h3>Assistant output · {session.spokenReply.state}</h3>
              <p>
                Reply transcript admitted to playback and shared with the
                backend
              </p>
              <blockquote>
                {session.spokenReply.text || "No spoken output yet."}
              </blockquote>
            </div>
          )}
          <p className="debug-note">
            Input path: {recognition.lastInputDisposition}
          </p>
        </>
      )}
      <details className="debug-details">
        <summary>Connection details</summary>
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
      </details>
    </section>
  );
}
