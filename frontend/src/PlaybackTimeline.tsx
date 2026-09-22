import {
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import type { Episode } from "@aside/engine/core";
import type { PlayerController } from "./usePlayerController";
import { t } from "./i18n";
const formatPlayerTime = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
// Decorative bars behind the seek slider; the same episode always draws the same shape.
const WAVE_BARS = 64;
function waveShape(seed: string) {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++)
    hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
  const phase = ((hash >>> 0) % 628) / 100;
  return Array.from({ length: WAVE_BARS }, (_, i) => {
    const shape =
      Math.sin(i * 0.55 + phase) * 0.5 +
      Math.sin(i * 0.19 + phase * 2) * 0.35 +
      Math.sin(i * 1.7) * 0.15;
    return 0.22 + 0.78 * Math.abs(shape);
  });
}
// A long episode yields one anchor per unmatched passage; drawn raw they merge into a
// solid bar that reads like a second progress track. Keep them at least this far apart.
const MIN_ANCHOR_GAP = 0.012;
export function PlaybackTimeline({
  player,
  episode,
}: {
  player: PlayerController;
  episode: Episode;
}) {
  const positionMs = useSyncExternalStore(
    player.session.subscribe,
    () => player.session.getSnapshot().state.positionMs,
  );
  const state = { ...player.state, positionMs };
  const { seek, liveStatus } = player;
  const audioPlaying = state.mode === "playing";
  const agentPresent = !!state.interruption && !state.resumeRequested;
  const agentJoining =
    agentPresent && ["connecting", "transcribing"].includes(liveStatus);
  const agentSpeaking = state.mode === "answering";
  const waveHeights = useMemo(
    () => waveShape(episode?.id ?? ""),
    [episode?.id],
  );
  const waveBars = useRef<HTMLSpanElement>(null);
  // Prefer the semantic groups over the single-passage fallbacks, then thin by distance so
  // the ticks stay readable as chapter marks instead of saturating the timeline.
  const timelineAnchors = useMemo(() => {
    const durationMs = episode?.durationMs ?? 0;
    const all = episode?.analysis?.anchors ?? [];
    if (durationMs <= 0 || !all.length) return [];
    const grouped = all.filter((a) => a.confidence >= 0.75);
    const kept: typeof all = [];
    let last = -Infinity;
    for (const a of grouped.length ? grouped : all) {
      const at = a.startMs / durationMs;
      if (at - last < MIN_ANCHOR_GAP) continue;
      kept.push(a);
      last = at;
    }
    return kept;
  }, [episode?.analysis?.anchors, episode?.durationMs]);
  const waveMotion = audioPlaying
    ? "podcast"
    : agentSpeaking
      ? "voice"
      : agentPresent && !agentJoining
        ? "idle"
        : "rest";
  const playheadBar =
    episode && episode.durationMs > 0
      ? (state.positionMs / episode.durationMs) * WAVE_BARS
      : 0;
  const readLevels = useRef(player.audioLevels);
  readLevels.current = player.audioLevels;
  const readVoiceLevels = useRef(player.voiceLevels);
  readVoiceLevels.current = player.voiceLevels;
  const waveScales = useRef(new Float32Array(WAVE_BARS).fill(1));
  // Bars follow whoever is audible: the podcast, or Aside's answer voice. Between turns
  // they breathe low while Aside is present, then ease back to the drawn shape.
  useEffect(() => {
    const bars = waveBars.current?.children;
    if (
      !bars?.length ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const levels = new Float32Array(bars.length);
    const scales = waveScales.current;
    let frame = 0;
    const draw = (now: number) => {
      const live =
        waveMotion === "podcast"
          ? readLevels.current(levels)
          : waveMotion === "voice" && readVoiceLevels.current(levels);
      let settled = waveMotion === "rest";
      for (let i = 0; i < bars.length; i++) {
        const target = live
          ? 0.28 + 0.72 * levels[i]
          : waveMotion === "rest"
            ? 1
            : 0.5 + 0.1 * Math.sin(now / 420 + i * 0.45);
        const current = scales[i];
        scales[i] += (target - current) * (target > current ? 0.45 : 0.14);
        if (Math.abs(scales[i] - target) > 0.005) settled = false;
        (bars[i] as HTMLElement).style.transform =
          `scaleY(${scales[i].toFixed(3)})`;
      }
      if (settled) {
        for (const bar of bars) (bar as HTMLElement).style.transform = "";
        return;
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [waveMotion, waveHeights]);
  return (
    <div className="dock-progress">
      <span>{formatPlayerTime(state.positionMs)}</span>
      <div className="timeline-wrap">
        <span
          className={`timeline-wave${agentPresent ? " is-agent" : ""}${agentJoining ? " is-joining" : ""}`}
          aria-hidden="true"
          ref={waveBars}
        >
          {waveHeights.map((height, index) => (
            <i
              key={index}
              className={
                episode.durationMs > 0 &&
                (index + 0.5) / waveHeights.length <=
                  state.positionMs / episode.durationMs
                  ? "on"
                  : undefined
              }
              style={
                {
                  height: `${Math.round(height * 100)}%`,
                  "--handoff-delay": `${Math.round(Math.abs(index + 0.5 - playheadBar) * 14)}ms`,
                } as CSSProperties
              }
            />
          ))}
        </span>
        <input
          aria-label={t("播放进度")}
          className="timeline"
          type="range"
          min={0}
          max={episode.durationMs}
          value={state.positionMs}
          onChange={(e) => seek(Number(e.target.value))}
        />
        {timelineAnchors.map((a) => (
          <i
            key={a.id}
            className="timeline-anchor"
            style={{
              left: `${(a.startMs / episode.durationMs) * 100}%`,
            }}
            title={a.text}
          />
        ))}
        {state.interruption && episode.durationMs > 0 && (
          <i
            className="timeline-resume"
            style={{
              left: `${(state.interruption.resumeMs / episode.durationMs) * 100}%`,
            }}
            title={t("从这里继续听")}
          />
        )}
      </div>
      <span>{formatPlayerTime(episode.durationMs)}</span>
    </div>
  );
}
