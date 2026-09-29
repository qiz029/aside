import React from "react";
import {
  Image,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Shared } from "./PlayerActivity";
import type { RecentEpisode } from "./recent-listening";

const time = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

export function RecentListeningCards({
  items,
  base,
  headers,
  onPlay,
  colors,
  tr,
}: Shared & {
  items: RecentEpisode[];
  base: string;
  headers: Record<string, string>;
  onPlay(id: string): void;
}) {
  const [latest, ...older] = items;
  if (!latest) return null;
  return (
    <View style={{ gap: 12, marginTop: 18 }}>
      <Pressable
        testID="continue-last"
        accessibilityRole="button"
        accessibilityLabel={`${tr("继续收听", "Continue listening")}: ${latest.title}, ${time(latest.positionMs)}`}
        onPress={() => onPlay(latest.id)}
        style={({ pressed }) => ({
          backgroundColor: colors.surface,
          borderRadius: 20,
          padding: 16,
          gap: 14,
          opacity: pressed ? 0.75 : 1,
          borderWidth: 1,
          borderColor: colors.line,
        })}
      >
        <Text
          style={{ color: colors.timestamp, fontSize: 13, fontWeight: "600" }}
        >
          {tr("继续收听", "Continue listening")}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          {latest.cover ? (
            <Image
              source={{
                uri: `${base}/api/episodes/${latest.id}/cover`,
                headers,
              }}
              style={{ width: 52, height: 52, borderRadius: 12 }}
            />
          ) : (
            <View
              style={{
                width: 52,
                height: 52,
                borderRadius: 12,
                backgroundColor: colors.highlight,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Ionicons
                name="musical-notes-outline"
                color={colors.accent}
                size={26}
              />
            </View>
          )}
          <View style={{ flex: 1, gap: 6 }}>
            <Text
              numberOfLines={2}
              style={{ fontSize: 17, fontWeight: "600", color: colors.text }}
            >
              {latest.title}
            </Text>
            <Text
              testID="continue-progress"
              style={{ color: colors.muted, fontSize: 12 }}
            >
              {tr(
                `已听 ${time(latest.positionMs)} · 剩余 ${time(Math.max(0, latest.durationMs - latest.positionMs))}`,
                `${time(latest.positionMs)} played · ${time(Math.max(0, latest.durationMs - latest.positionMs))} left`,
              )}
            </Text>
          </View>
          <Ionicons name="play-circle" size={36} color={colors.accent} />
        </View>
        <View
          style={{
            height: 4,
            borderRadius: 2,
            backgroundColor: colors.line,
            overflow: "hidden",
          }}
        >
          <View
            style={{
              height: 4,
              backgroundColor: colors.accent,
              width: `${latest.durationMs ? Math.min(1, latest.positionMs / latest.durationMs) * 100 : 0}%`,
            }}
          />
        </View>
      </Pressable>
      {older.length ? (
        <>
          <Text style={{ color: colors.muted, fontSize: 13 }}>
            {tr("最近听过", "Recently played")}
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 10 }}
          >
            {older.map((item) => (
              <Pressable
                key={item.id}
                testID={`recent-${item.id}`}
                accessibilityRole="button"
                accessibilityLabel={`${tr("继续收听", "Continue listening")}: ${item.title}`}
                onPress={() => onPlay(item.id)}
                style={{
                  width: 190,
                  minHeight: 64,
                  padding: 12,
                  gap: 6,
                  borderRadius: 12,
                  backgroundColor: colors.fill,
                }}
              >
                <Text
                  numberOfLines={2}
                  style={{ fontSize: 14, color: colors.text }}
                >
                  {item.title}
                </Text>
                <Text style={{ fontSize: 12, color: colors.muted }}>
                  {time(item.positionMs)} / {time(item.durationMs)}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </>
      ) : null}
    </View>
  );
}

export function FirstQuestionHint({
  listening,
  handsfree,
  signedIn,
  onDismiss,
  colors,
  tr,
}: Shared & {
  listening: boolean;
  handsfree: boolean;
  signedIn: boolean;
  onDismiss(): void;
}) {
  return (
    <View
      testID="first-question-hint"
      style={{
        padding: 14,
        margin: 16,
        gap: 8,
        borderRadius: 16,
        backgroundColor: colors.highlight,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Ionicons
          name="chatbubble-ellipses-outline"
          size={20}
          color={colors.accent}
        />
        <Text
          style={{
            flex: 1,
            fontWeight: "600",
            fontSize: 15,
            color: colors.text,
          }}
        >
          {tr("好奇的地方，随时问", "A question? Just ask")}
        </Text>
        <Pressable
          testID="dismiss-first-question"
          accessibilityRole="button"
          accessibilityLabel={tr("关闭提问提示", "Dismiss question tip")}
          onPress={onDismiss}
          style={{
            minHeight: 44,
            minWidth: 44,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Ionicons name="close" size={20} color={colors.muted} />
        </Pressable>
      </View>
      <Text style={{ fontSize: 15, lineHeight: 22, color: colors.text }}>
        {tr(
          "试着问：“刚才那个词是什么意思？”",
          "Try asking: “What does that word mean?”",
        )}
      </Text>
      <Text style={{ fontSize: 13, lineHeight: 20, color: colors.muted }}>
        {!signedIn
          ? tr(
              "登录后可以提问；现在也可以继续听。",
              "Sign in to ask questions. You can keep listening now.",
            )
          : listening
            ? tr(
                "麦克风已开启，直接开口就好。点下方“关闭”即可关掉麦克风。",
                "Your microphone is on. Just speak; tap Stop below to turn it off.",
              )
            : handsfree
              ? tr(
                  "麦克风尚未开启。播放后，允许麦克风即可直接开口；也可以打字提问。",
                  "Your microphone is off. Press play and allow access to speak, or type a question.",
                )
              : tr(
                  "按住麦克风说话，松开发送；也可以打字提问。",
                  "Hold the microphone to talk, release to send, or type a question.",
                )}
      </Text>
    </View>
  );
}

export function InlineAnswer({
  question,
  answer,
  busy,
  atMs,
  onReplay,
  onExpand,
  onDismiss,
  colors,
  tr,
}: Shared & {
  question: string;
  answer: string;
  busy: boolean;
  atMs?: number;
  onReplay(): void;
  onExpand(): void;
  onDismiss(): void;
}) {
  const screen = useWindowDimensions();
  return (
    <View
      testID="inline-answer"
      style={{
        marginHorizontal: 16,
        marginBottom: 8,
        padding: 14,
        gap: 8,
        backgroundColor: colors.surface,
        borderColor: colors.line,
        borderWidth: 1,
        borderRadius: 16,
        flexShrink: 0,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          maxFontSizeMultiplier={1.5}
          style={{
            color: colors.amberInk,
            fontSize: 13,
            fontWeight: "600",
            flex: 1,
          }}
        >
          {busy
            ? answer
              ? tr("Aside · 正在回答", "Aside · answering")
              : tr("Aside · 问题已收到", "Aside · question received")
            : "Aside"}
        </Text>
        <Pressable
          testID="dismiss-inline-answer"
          accessibilityRole="button"
          accessibilityLabel={tr("收起回答", "Dismiss answer preview")}
          onPress={onDismiss}
          style={{
            minHeight: 44,
            minWidth: 44,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Ionicons name="close" size={18} color={colors.muted} />
        </Pressable>
      </View>
      <ScrollView
        style={{ maxHeight: Math.min(132, screen.height * 0.16), flexGrow: 0 }}
        contentContainerStyle={{ gap: 8 }}
      >
        <Text numberOfLines={1} style={{ fontSize: 12, color: colors.muted }}>
          {question}
        </Text>
        <Text
          testID="inline-answer-text"
          numberOfLines={3}
          style={{ color: colors.text, fontSize: 16, lineHeight: 23 }}
        >
          {answer ||
            (busy
              ? tr(
                  "问题已收到，正在想一想…",
                  "Question received. Thinking it through…",
                )
              : tr(
                  "回答已停止，随时再问。",
                  "Answer stopped. Ask again when you're ready.",
                ))}
        </Text>
      </ScrollView>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {atMs !== undefined ? (
          <Pressable
            testID="replay-question-passage"
            accessibilityRole="button"
            onPress={onReplay}
            style={{
              minHeight: 44,
              justifyContent: "center",
              paddingRight: 12,
            }}
          >
            <Text
              maxFontSizeMultiplier={1.5}
              style={{ color: colors.timestamp, fontSize: 13 }}
            >
              {tr(`回听提问处 ${time(atMs)}`, `Replay from ${time(atMs)}`)}
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          testID="expand-inline-answer"
          accessibilityRole="button"
          onPress={onExpand}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text
            maxFontSizeMultiplier={1.5}
            style={{ color: colors.accent, fontSize: 13, fontWeight: "600" }}
          >
            {tr("展开对话", "Open conversation")} →
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
