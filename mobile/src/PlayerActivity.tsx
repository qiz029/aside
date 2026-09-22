import React, { useEffect, useState, useSyncExternalStore } from "react";
import { AppState, Text, View } from "react-native";
import type { ListeningSession } from "@aside/player-runtime/listening-session";
import type { SessionSnapshot } from "./session-selection";
import { Scrubber } from "./Scrubber";

type Shared = {
  colors: {
    accent: string;
    line: string;
    amber: string;
    amberInk: string;
    muted: string;
    highlight: string;
    fill: string;
    text: string;
    timestamp: string;
  };
  tr(zh: string, en: string): string;
};
const formatTime = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
export function PlaybackTimeline({
  session,
  durationMs,
  colors,
  tr,
}: Shared & { session: ListeningSession; durationMs: number }) {
  const positionMs = useSyncExternalStore(
    session.subscribe,
    () => session.getSnapshot().state.positionMs,
  );
  return (
    <>
      <Scrubber
        positionMs={positionMs}
        durationMs={durationMs}
        colors={colors}
        label={tr("播放进度", "Playback position")}
        fineLabel={(speed) =>
          speed === 1
            ? tr("手指上移，拖得更精细", "Slide up for finer scrubbing")
            : tr(
                `${speed === 0.5 ? "半速" : "四分之一速"}精细拖动`,
                `${speed === 0.5 ? "Half" : "Quarter"}-speed scrubbing`,
              )
        }
        formatTime={formatTime}
        onSeek={(value) => {
          session.seek(value);
          session.start();
        }}
      />
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          marginTop: -6,
        }}
      >
        <Text
          testID="playback-position"
          maxFontSizeMultiplier={1.5}
          style={{
            color: colors.muted,
            fontSize: 11,
            fontVariant: ["tabular-nums"],
          }}
        >
          {formatTime(positionMs)}
        </Text>
        <Text
          maxFontSizeMultiplier={1.5}
          style={{
            color: colors.muted,
            fontSize: 11,
            fontVariant: ["tabular-nums"],
          }}
        >
          −{formatTime(Math.max(0, durationMs - positionMs))}
        </Text>
      </View>
    </>
  );
}
export function CaptureStatus({
  snapshot,
  captureCancelled,
  colors,
  tr,
}: Shared & {
  snapshot: Pick<SessionSnapshot, "manualHeld" | "liveStatus" | "busy">;
  captureCancelled: boolean;
}) {
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  useEffect(() => {
    setRecordingSeconds(0);
    if (!snapshot.manualHeld || snapshot.liveStatus !== "armed") return;
    const start = Date.now();
    const timer = setInterval(
      () =>
        setRecordingSeconds(
          Math.min(30, Math.floor((Date.now() - start) / 1000)),
        ),
      1000,
    );
    return () => clearInterval(timer);
  }, [snapshot.manualHeld, snapshot.liveStatus]);
  return (
    <Text
      testID="manual-capture-status"
      maxFontSizeMultiplier={1.6}
      style={{ color: colors.muted, fontSize: 12 }}
    >
      {captureCancelled
        ? tr("已取消", "Recording cancelled")
        : snapshot.manualHeld
          ? snapshot.liveStatus === "arming"
            ? tr("正在准备麦克风…", "Preparing microphone…")
            : tr(
                `松开发送 · 滑出取消 · ${recordingSeconds}s`,
                `Release to send · Slide to cancel · ${recordingSeconds}s`,
              )
          : snapshot.liveStatus === "transcribing"
            ? tr("正在转写…", "Transcribing…")
            : snapshot.liveStatus === "connecting"
              ? tr("正在连接语音…", "Connecting voice…")
              : snapshot.busy
                ? tr("按住继续提问", "Hold to ask another question")
                : tr("按住说话", "Hold to talk")}
    </Text>
  );
}
export function ListeningIndicator({
  session,
  status,
  colors,
  tr,
  children,
}: Shared & {
  session: ListeningSession;
  status: SessionSnapshot["liveStatus"];
  children: React.ReactNode;
}) {
  const [inputLevel, setInputLevel] = useState(0);
  useEffect(() => {
    if (status !== "on") {
      setInputLevel(0);
      return;
    }
    let timer: ReturnType<typeof setInterval> | undefined;
    const update = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (AppState.currentState === "active")
        timer = setInterval(
          () => setInputLevel(session.microphoneLevel()),
          100,
        );
      else setInputLevel(0);
    };
    update();
    const subscription = AppState.addEventListener("change", update);
    return () => {
      if (timer) clearInterval(timer);
      subscription.remove();
    };
  }, [session, status]);
  return (
    <View
      style={[
        {
          flex: 1,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          borderRadius: 26,
          paddingLeft: 18,
          paddingRight: 4,
          paddingVertical: 4,
          minHeight: 52,
        },
        {
          backgroundColor: status === "on" ? colors.highlight : colors.fill,
        },
      ]}
    >
      <View
        style={[
          { width: 10, height: 10, borderRadius: 5 },
          {
            // Amber while the microphone hears a voice.
            backgroundColor:
              status !== "on"
                ? colors.muted
                : inputLevel > 0.04
                  ? colors.amber
                  : colors.timestamp,
          },
        ]}
      />
      <Text
        testID="voice-connection-status"
        maxFontSizeMultiplier={1.6}
        style={{
          flex: 1,
          color: colors.text,
          fontSize: 14,
          fontWeight: "600",
        }}
      >
        {status === "on"
          ? tr("正在聆听 · 直接开口就好", "Listening · just speak")
          : status === "connecting"
            ? tr("正在连接…", "Connecting…")
            : tr("麦克风已关闭", "Microphone is off")}
      </Text>
      {status === "on" && (
        <View
          testID="microphone-level"
          accessibilityLabel={tr("麦克风音量", "Microphone activity")}
          style={{
            flexDirection: "row",
            height: 22,
            alignItems: "center",
            gap: 3,
          }}
        >
          {[0.65, 1, 0.8, 0.5].map((scale, i) => (
            <View
              key={i}
              style={{
                width: 3,
                borderRadius: 2,
                height: Math.max(4, Math.min(22, inputLevel * 160 * scale)),
                backgroundColor:
                  inputLevel > 0.04 ? colors.amber : colors.timestamp,
              }}
            />
          ))}
        </View>
      )}
      {children}
    </View>
  );
}
