import React from "react";
import { Modal, ScrollView, Text, Pressable, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { privacyCopy } from "./privacy-policy";
export { CONSENT_VERSION } from "./privacy-policy";
export function PrivacyPanel({
  visible,
  consent,
  locale,
  dark,
  busy,
  close,
  accept,
}: {
  visible: boolean;
  consent: boolean;
  locale: string;
  dark: boolean;
  busy: boolean;
  close(): void;
  accept(): void;
}) {
  const color = dark ? "#ece5d8" : "#2b2520";
  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={() => {
        if (!busy) close();
      }}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: dark ? "#1a1816" : "#f6f1e8" }}
      >
        <ScrollView contentContainerStyle={{ padding: 24, gap: 22 }}>
          {privacyCopy[locale === "zh" ? "zh" : "en"].map(([title, body]) => (
            <View key={title} style={{ gap: 8 }}>
              <Text
                accessibilityRole="header"
                style={{ color, fontSize: 22, fontWeight: "600" }}
              >
                {title}
              </Text>
              <Text style={{ color, fontSize: 16, lineHeight: 26 }}>
                {body}
              </Text>
            </View>
          ))}
        </ScrollView>
        <View style={{ padding: 20, gap: 12 }}>
          {consent && (
            <Pressable
              accessibilityRole="button"
              testID="accept-ai-consent"
              disabled={busy}
              onPress={accept}
              style={{
                padding: 16,
                borderRadius: 14,
                backgroundColor: "#334d3d",
                alignItems: "center",
              }}
            >
              <Text style={{ color: "#fff", fontSize: 17 }}>
                {busy
                  ? locale === "zh"
                    ? "正在保存…"
                    : "Saving…"
                  : locale === "zh"
                    ? "同意并继续"
                    : "Agree and continue"}
              </Text>
            </Pressable>
          )}
          <Pressable
            accessibilityRole="button"
            testID="close-privacy"
            disabled={busy}
            onPress={close}
            style={{ padding: 14, alignItems: "center" }}
          >
            <Text style={{ color, fontSize: 17 }}>
              {consent
                ? locale === "zh"
                  ? "暂不同意"
                  : "Not now"
                : locale === "zh"
                  ? "完成"
                  : "Done"}
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </Modal>
  );
}
