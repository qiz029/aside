import React, { useRef, useState } from "react";
import { Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { scrubRate } from "./scrub-rate";

export function Scrubber({
  positionMs,
  durationMs,
  colors,
  label,
  fineLabel,
  formatTime,
  onSeek,
}: {
  positionMs: number;
  durationMs: number;
  colors: { accent: string; line: string; amber: string; amberInk: string };
  label: string;
  fineLabel(rate: number): string;
  formatTime(ms: number): string;
  onSeek(ms: number): void;
}) {
  const [width, setWidth] = useState(1);
  const [drag, setDrag] = useState<{ ms: number; rate: number } | null>(null);
  const start = useRef({ ms: 0, lastX: 0 });
  const clamp = (ms: number) => Math.max(0, Math.min(durationMs, ms));
  const pan = Gesture.Pan()
    .runOnJS(true)
    .minDistance(0)
    .onBegin((event) => {
      const ms = clamp((event.x / width) * durationMs);
      start.current = { ms, lastX: event.absoluteX };
      setDrag({ ms, rate: 1 });
    })
    .onUpdate((event) => {
      const rate = scrubRate(-event.translationY);
      const dx = event.absoluteX - start.current.lastX;
      const ms = clamp(start.current.ms + (dx / width) * durationMs * rate);
      start.current = { ms, lastX: event.absoluteX };
      setDrag({ ms, rate });
    })
    .onEnd(() => onSeek(start.current.ms))
    .onFinalize(() => setDrag(null));
  const shown = drag?.ms ?? positionMs;
  const fraction = durationMs > 0 ? shown / durationMs : 0;
  const step = Math.max(1000, durationMs / 20);
  return (
    <View>
      {drag ? (
        <View style={{ alignItems: "center", paddingBottom: 2 }}>
          <Text
            maxFontSizeMultiplier={1.3}
            style={{
              color: colors.accent,
              fontSize: 30,
              fontVariant: ["tabular-nums"],
            }}
          >
            {formatTime(drag.ms)}
          </Text>
          <Text
            maxFontSizeMultiplier={1.3}
            style={{ color: colors.amberInk, fontSize: 12 }}
          >
            {fineLabel(drag.rate)}
          </Text>
        </View>
      ) : null}
      <GestureDetector gesture={pan}>
        <View
          testID="progress"
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={label}
          accessibilityValue={{
            min: 0,
            max: Math.round(durationMs / 1000),
            now: Math.round(shown / 1000),
          }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={({ nativeEvent }) =>
            onSeek(
              clamp(
                positionMs +
                  (nativeEvent.actionName === "increment" ? 1 : -1) * step,
              ),
            )
          }
          onLayout={({ nativeEvent }) =>
            setWidth(Math.max(1, nativeEvent.layout.width))
          }
          style={{ height: 36, justifyContent: "center" }}
        >
          <View
            style={{
              height: drag ? 8 : 4,
              borderRadius: 4,
              backgroundColor: colors.line,
            }}
          >
            <View
              style={{
                width: `${fraction * 100}%`,
                height: "100%",
                borderRadius: 4,
                backgroundColor: colors.accent,
              }}
            />
          </View>
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              left: fraction * width - (drag ? 14 : 7),
              width: drag ? 28 : 14,
              height: drag ? 28 : 14,
              borderRadius: 14,
              backgroundColor: colors.accent,
              borderWidth: drag ? 5 : 0,
              borderColor: colors.amber,
            }}
          />
        </View>
      </GestureDetector>
    </View>
  );
}
