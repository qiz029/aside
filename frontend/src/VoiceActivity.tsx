import { useEffect, useRef, useState } from "react";
import type { VoiceStatus } from "@aside/player-runtime/ports";
import { t } from "./i18n";
import "./voice-activity.css";

const shape = [0.35, 0.65, 0.85, 1, 0.85, 0.65, 0.35];

/** The tail of a long caption, so the newest words stay in view. */
const tail = (text: string, max = 120) =>
  text.length > max ? `…${text.slice(-max).trimStart()}` : text;

/**
 * Local input feedback, independent of intent decisions or model latency,
 * with what the app heard: the listener's words while it decides, a retry for
 * words it set aside, and the state of the voice connection.
 */
export function VoiceActivity({
  status,
  readLevel,
  heard,
  missed,
  reconnecting,
  notice,
  onAskMissed,
  onReconnect,
}: {
  status: VoiceStatus;
  readLevel: () => number;
  heard?: { text: string } | null;
  missed?: { text: string } | null;
  reconnecting?: boolean;
  notice?: "expired" | null;
  onAskMissed?: () => void;
  onReconnect?: () => void;
}) {
  const meter = useRef<HTMLSpanElement>(null);
  const latest = useRef(readLevel);
  latest.current = readLevel;
  const [hearing, setHearing] = useState(false);
  const enabled = status !== "off";

  useEffect(() => {
    setHearing(false);
    if (!enabled) return;
    const bars = meter.current?.children;
    if (!bars) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let level = 0;
    let audibleUntil = 0;
    let wasHearing = false;
    let previous = 0;
    const draw = (now: number) => {
      // 30 fps is enough for a small meter; React updates only on state changes.
      if (now - previous >= 32) {
        previous = now;
        const input = latest.current();
        const rms = Number.isFinite(input) ? Math.max(0, input) : 0;
        if (rms > 0.008) audibleUntil = now + 350;
        const active = now < audibleUntil;
        if (active !== wasHearing) {
          wasHearing = active;
          setHearing(active);
        }
        const target = Math.min(1, Math.max(0, (rms - 0.004) * 10));
        level += (target - level) * (target > level ? 0.65 : 0.25);
        for (let i = 0; i < bars.length; i++) {
          const scale = motion.matches
            ? active
              ? 0.65
              : 0.15
            : 0.15 + level * shape[i] * 0.85;
          (bars[i] as HTMLElement).style.transform =
            `scaleY(${scale.toFixed(3)})`;
        }
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [enabled]);

  const extras = (
    <>
      {heard?.text && (
        <p className="heard-caption" aria-live="polite">
          “{tail(heard.text)}”
        </p>
      )}
      {missed && (
        <button
          type="button"
          className="missed-offer btn btn-secondary btn-sm"
          onClick={onAskMissed}
        >
          <span>{t("没当成提问")}</span>
          <span className="missed-offer-text">“{tail(missed.text, 48)}”</span>
          <strong>{t("点这里问")}</strong>
        </button>
      )}
      {notice === "expired" && (
        <div className="voice-notice" role="status">
          <span>{t("这次免费语音对话到时间了，节目会继续播放。")}</span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onReconnect}
          >
            {t("再开一段语音")}
          </button>
        </div>
      )}
    </>
  );
  if (!enabled && !reconnecting)
    return notice ? <div className="voice-activity-row">{extras}</div> : null;
  const connecting =
    reconnecting || status === "arming" || status === "connecting";
  const listening = hearing || !!heard;
  const label = reconnecting
    ? t("语音断了，正在重新连接…")
    : status === "arming"
      ? t("正在开启麦克风")
      : status === "connecting"
        ? t("正在连接语音")
        : heard
          ? t("在听你说")
          : hearing
            ? t("正在接收声音")
            : t("麦克风已开启");

  return (
    <div className="voice-activity-row">
      <div
        className="voice-activity"
        data-hearing={listening || undefined}
        data-connecting={connecting || undefined}
        aria-label={t("麦克风反馈")}
        role="group"
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" />
          <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" />
        </svg>
        <span className="voice-activity-bars" ref={meter} aria-hidden="true">
          {shape.map((_, i) => (
            <i key={i} />
          ))}
        </span>
        <span className="voice-activity-label" aria-live="off">
          {label}
        </span>
      </div>
      {extras}
    </div>
  );
}
