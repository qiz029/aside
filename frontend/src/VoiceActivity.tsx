import { useEffect, useRef, useState } from "react";
import type { VoiceStatus } from "@aside/player-runtime/ports";
import { t } from "./i18n";
import "./voice-activity.css";

const shape = [0.35, 0.65, 0.85, 1, 0.85, 0.65, 0.35];

/** Local input feedback, independent of intent decisions or model latency. */
export function VoiceActivity({
  status,
  readLevel,
}: {
  status: VoiceStatus;
  readLevel: () => number;
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

  if (!enabled) return null;
  const connecting = status === "arming" || status === "connecting";
  const label =
    status === "arming"
      ? t("正在开启麦克风")
      : status === "connecting"
        ? t("正在连接语音")
        : hearing
          ? t("正在接收声音")
          : t("麦克风已开启");

  return (
    <div className="voice-activity-row">
      <div
        className="voice-activity"
        data-hearing={hearing || undefined}
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
    </div>
  );
}
