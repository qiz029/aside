import React, { useEffect, useState, useSyncExternalStore } from "react";
import { AppState, Linking, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
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
    surface: string;
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
/** Only the tail of long provisional speech fits the bar. */
export const hearingTail = (text: string, max = 120) =>
  text.length > max ? `…${text.slice(-max).trimStart()}` : text;
export function ListeningIndicator({
  session,
  status,
  hearing,
  reconnecting,
  colors,
  tr,
  children,
}: Shared & {
  session: ListeningSession;
  status: SessionSnapshot["liveStatus"];
  hearing: SessionSnapshot["hearing"];
  reconnecting: boolean;
  children: React.ReactNode;
}) {
  const caption = hearing ? hearingTail(hearing.text.trim()) : "";
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
      <View
        accessibilityLiveRegion="polite"
        style={{ flex: 1, paddingVertical: caption ? 6 : 0, gap: 2 }}
      >
        <Text
          testID="voice-connection-status"
          maxFontSizeMultiplier={1.6}
          style={{
            color: colors.text,
            fontSize: 14,
            fontWeight: "600",
          }}
        >
          {reconnecting
            ? tr("语音断了，正在重新连接…", "Voice dropped. Reconnecting…")
            : status === "on"
              ? hearing
                ? tr("在听你说", "Listening to you")
                : tr("正在聆听 · 直接开口就好", "Listening · just speak")
              : status === "connecting"
                ? tr("正在连接…", "Connecting…")
                : tr("麦克风已关闭", "Microphone is off")}
        </Text>
        {!reconnecting && status === "on" && caption ? (
          <Text
            testID="hearing-caption"
            maxFontSizeMultiplier={1.4}
            numberOfLines={3}
            style={{
              color: colors.muted,
              fontSize: 13,
              lineHeight: 18,
              fontStyle: "italic",
            }}
          >
            {caption}
          </Text>
        ) : null}
      </View>
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

/** A short quote of what the listener said, for chips and labels. */
const excerpt = (text: string, max = 40) => {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean;
};
/** One tap turns speech the backend set aside into a question. */
export function MissedChip({
  missed,
  onAsk,
  colors,
  tr,
}: Shared & { missed: { text: string }; onAsk(): void }) {
  const quote = excerpt(missed.text);
  const label = tr("没当成提问 · 点这里问", "Not taken as a question · Ask it");
  return (
    <Pressable
      testID="ask-missed"
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${quote}`}
      onPress={onAsk}
      style={({ pressed }) => ({
        alignSelf: "flex-start",
        maxWidth: "100%",
        minHeight: 44,
        justifyContent: "center",
        borderRadius: 18,
        paddingHorizontal: 16,
        paddingVertical: 7,
        marginTop: 6,
        backgroundColor: colors.fill,
        opacity: pressed ? 0.65 : 1,
        transform: [{ scale: pressed ? 0.97 : 1 }],
      })}
    >
      <Text
        maxFontSizeMultiplier={1.5}
        numberOfLines={1}
        style={{ color: colors.text, fontSize: 13, fontWeight: "600" }}
      >
        {label}
      </Text>
      <Text
        maxFontSizeMultiplier={1.4}
        numberOfLines={1}
        style={{ color: colors.muted, fontSize: 12, fontStyle: "italic" }}
      >
        {tr(`「${quote}」`, `“${quote}”`)}
      </Text>
    </Pressable>
  );
}
/** A guest's free voice session ran out: calm, not an error. */
export function VoiceExpiredNotice({
  onReconnect,
  colors,
  tr,
}: Shared & { onReconnect(): void }) {
  const action = tr("再开一段语音", "Start voice again");
  return (
    <View
      testID="voice-expired"
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
        marginTop: 6,
        borderRadius: 18,
        paddingLeft: 14,
        paddingRight: 8,
        paddingVertical: 8,
        backgroundColor: colors.fill,
      }}
    >
      <Text
        maxFontSizeMultiplier={1.5}
        style={{
          color: colors.text,
          fontSize: 14,
          lineHeight: 20,
          flexGrow: 1,
          flexShrink: 1,
          flexBasis: 160,
        }}
      >
        {tr(
          "这次免费语音对话到时间了，节目会继续播放。",
          "This free voice session has ended. The podcast keeps playing.",
        )}
      </Text>
      <Pressable
        testID="reconnect-voice"
        accessibilityRole="button"
        accessibilityLabel={action}
        onPress={onReconnect}
        style={({ pressed }) => ({
          minHeight: 44,
          borderRadius: 22,
          paddingHorizontal: 16,
          paddingVertical: 11,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.surface,
          opacity: pressed ? 0.65 : 1,
          transform: [{ scale: pressed ? 0.97 : 1 }],
        })}
      >
        <Text
          maxFontSizeMultiplier={1.5}
          style={{ color: colors.text, fontWeight: "600", fontSize: 14 }}
        >
          {action}
        </Text>
      </Pressable>
    </View>
  );
}
/** The latest answer's references, collapsed until the listener asks. */
export function AnswerSources({
  sources,
  onSeek,
  onError,
  colors,
  tr,
}: Shared & {
  sources: SessionSnapshot["sources"];
  onSeek(atMs: number): void;
  onError(error: unknown): void;
}) {
  const [open, setOpen] = useState(false);
  if (!sources.length) return null;
  const heading = tr(
    `参考材料 · ${sources.length}`,
    `Sources · ${sources.length}`,
  );
  return (
    <View testID="answer-sources" style={{ gap: 2 }}>
      <Pressable
        testID="toggle-sources"
        accessibilityRole="button"
        accessibilityLabel={heading}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={({ pressed }) => ({
          alignSelf: "flex-start",
          minHeight: 44,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          opacity: pressed ? 0.65 : 1,
        })}
      >
        <Text
          maxFontSizeMultiplier={1.5}
          style={{ color: colors.muted, fontSize: 13, fontWeight: "600" }}
        >
          {heading}
        </Text>
        <Ionicons
          name={open ? "chevron-up" : "chevron-down"}
          size={14}
          color={colors.muted}
        />
      </Pressable>
      {open &&
        sources.map((source, i) => {
          const url = source.url;
          const atMs = source.startMs;
          const where = url
            ? url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")
            : atMs !== undefined
              ? formatTime(atMs)
              : "";
          const action = url
            ? () => void Linking.openURL(url).catch(onError)
            : atMs !== undefined
              ? () => onSeek(atMs)
              : undefined;
          return (
            <Pressable
              key={i}
              testID={`source-${i}`}
              accessibilityRole={url ? "link" : action ? "button" : "text"}
              accessibilityLabel={
                url
                  ? source.text
                  : atMs !== undefined
                    ? tr(
                        `从 ${where} 播放：${source.text}`,
                        `Play from ${where}: ${source.text}`,
                      )
                    : source.text
              }
              disabled={!action}
              onPress={action}
              style={({ pressed }) => ({
                minHeight: 44,
                justifyContent: "center",
                paddingVertical: 6,
                gap: 2,
                opacity: pressed ? 0.65 : 1,
              })}
            >
              {where ? (
                <Text
                  maxFontSizeMultiplier={1.4}
                  numberOfLines={1}
                  style={{
                    color: colors.timestamp,
                    fontSize: 12,
                    fontWeight: "600",
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {where}
                </Text>
              ) : null}
              <Text
                maxFontSizeMultiplier={1.5}
                numberOfLines={3}
                style={{
                  color: url ? colors.accent : colors.text,
                  fontSize: 14,
                  lineHeight: 20,
                  textDecorationLine: url ? "underline" : "none",
                }}
              >
                {source.text}
              </Text>
            </Pressable>
          );
        })}
    </View>
  );
}
