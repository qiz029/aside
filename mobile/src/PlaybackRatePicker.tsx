import React from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import type { Shared } from "./PlayerActivity";

export function PlaybackRatePicker({
  visible,
  rate,
  onSelect,
  onClose,
  colors,
  tr,
}: Shared & {
  visible: boolean;
  rate: number;
  onSelect(rate: number): void;
  onClose(): void;
}) {
  const insets = useSafeAreaInsets();
  const { height, fontScale } = useWindowDimensions();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View
        style={{
          flex: 1,
          justifyContent: "flex-end",
          backgroundColor: "#2b252080",
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={tr("关闭倍速选择", "Close playback speed")}
          onPress={onClose}
          style={{ flex: 1 }}
        />
        <View
          accessibilityViewIsModal
          style={{
            height: Math.min(height * 0.8, 430 * Math.max(1, fontScale)),
            backgroundColor: colors.surface,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            padding: 20,
            paddingBottom: Math.max(insets.bottom, 16),
          }}
        >
          <View
            style={{
              flexDirection: "row",
              flexShrink: 0,
              alignItems: "center",
              marginBottom: 8,
            }}
          >
            <Text
              accessibilityRole="header"
              style={{
                flex: 1,
                color: colors.text,
                fontSize: 20,
                fontWeight: "600",
              }}
            >
              {tr("播放速度", "Playback speed")}
            </Text>
            <Pressable
              testID="close-speed-options"
              accessibilityRole="button"
              onPress={onClose}
              style={{
                minHeight: 44,
                paddingHorizontal: 12,
                justifyContent: "center",
              }}
            >
              <Text style={{ color: colors.accent, fontSize: 17 }}>
                {tr("完成", "Done")}
              </Text>
            </Pressable>
          </View>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ gap: 4 }}
          >
            {[0.75, 1, 1.25, 1.5, 1.75, 2].map((value) => (
              <Pressable
                key={value}
                testID={`speed-${value}`}
                accessibilityRole="radio"
                accessibilityState={{ checked: rate === value }}
                accessibilityLabel={`${value}×`}
                onPress={() => onSelect(value)}
                style={{
                  minHeight: 52,
                  padding: 14,
                  borderRadius: 12,
                  backgroundColor:
                    rate === value ? colors.highlight : "transparent",
                  flexDirection: "row",
                  alignItems: "center",
                }}
              >
                <Text style={{ flex: 1, fontSize: 17, color: colors.text }}>
                  {value}×{value === 1 ? tr(" · 正常", " · Normal") : ""}
                </Text>
                {rate === value ? (
                  <Ionicons name="checkmark" size={22} color={colors.accent} />
                ) : null}
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
