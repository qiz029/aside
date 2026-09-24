import React, { useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import type { MobileApi, User } from "./api";
import { AppleSignIn } from "./AppleSignIn";

type Colors = {
  text: string;
  muted: string;
  accent: string;
  onAccent: string;
  surface: string;
  line: string;
  amberInk: string;
  amberSurface: string;
};
export function ProviderSignIn({
  api,
  locale,
  colors,
  dark,
  header = true,
  onSignedIn,
}: {
  api: MobileApi;
  locale: string;
  colors: Colors;
  dark: boolean;
  header?: boolean;
  onSignedIn(user: User): Promise<void>;
}) {
  const tr = (zh: string, en: string) => (locale === "zh" ? zh : en);
  const [busy, setBusy] = useState<"google" | "apple" | null>(null);
  const [error, setError] = useState("");
  const pending = useRef(false);
  // iOS uses the native Apple sheet; elsewhere Apple runs in the browser.
  const nativeApple =
    Platform.OS === "ios" &&
    api.appleEnabled &&
    !!Constants.expoConfig?.extra?.appleSignInEnabled;
  async function browser(provider: "google" | "apple") {
    if (pending.current) return;
    pending.current = true;
    setBusy(provider);
    setError("");
    try {
      const user = await api.browserSignIn(provider);
      if (user) await onSignedIn(user);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(
        /Network request failed|Failed to fetch/i.test(message)
          ? tr(
              "暂时无法连接，请检查网络后重试。",
              "Unable to connect. Check your connection and try again.",
            )
          : message,
      );
    } finally {
      pending.current = false;
      setBusy(null);
    }
  }
  function provider(
    kind: "google" | "apple",
    label: string,
    icon: "logo-google" | "logo-apple",
  ) {
    const apple = kind === "apple";
    const foreground = apple ? (dark ? "#000" : "#fff") : colors.text;
    return (
      <Pressable
        testID={`${kind}-sign-in`}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: !!busy, busy: busy === kind }}
        disabled={!!busy}
        onPress={() => void browser(kind)}
        style={({ pressed }) => ({
          minHeight: 52,
          borderRadius: 14,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          paddingHorizontal: 16,
          opacity: busy && busy !== kind ? 0.5 : pressed ? 0.7 : 1,
          backgroundColor: apple
            ? dark
              ? "#fff"
              : "#000"
            : colors.surface,
          borderWidth: apple ? 0 : 1,
          borderColor: colors.line,
        })}
      >
        {busy === kind ? (
          <ActivityIndicator color={foreground} />
        ) : (
          <>
            <Ionicons name={icon} size={19} color={foreground} />
            <Text
              maxFontSizeMultiplier={1.5}
              style={{ color: foreground, fontSize: 17, fontWeight: "600" }}
            >
              {label}
            </Text>
          </>
        )}
      </Pressable>
    );
  }
  const none = !nativeApple && !api.appleWebEnabled && !api.googleEnabled;
  return (
    <View style={{ gap: 20, paddingTop: 8 }}>
      {header && (
        <>
          {/* The website's sign-in dialog: badge, headline, one sentence. */}
          <View
            accessible={false}
            style={{
              width: 48,
              height: 48,
              borderRadius: 14,
              backgroundColor: colors.accent,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
            }}
          >
            {[10, 22, 15, 6].map((height, i) => (
              <View
                key={i}
                style={{
                  width: 3,
                  height,
                  borderRadius: 2,
                  backgroundColor: colors.onAccent,
                }}
              />
            ))}
          </View>
          <View style={{ gap: 8 }}>
            <Text
              maxFontSizeMultiplier={1.4}
              style={{
                color: colors.text,
                fontSize: 26,
                lineHeight: 34,
                fontWeight: "600",
              }}
            >
              {tr("从这里继续听", "Pick up where you left off")}
            </Text>
            <Text style={{ color: colors.muted, fontSize: 16, lineHeight: 25 }}>
              {tr(
                "登录后保存你的音频和收听进度。",
                "Sign in to keep your audio and your place.",
              )}
            </Text>
          </View>
        </>
      )}
      <View style={{ gap: 12 }}>
        {nativeApple ? (
          <AppleSignIn api={api} locale={locale} onSignedIn={onSignedIn} />
        ) : (
          api.appleWebEnabled &&
          provider("apple", tr("使用 Apple 登录", "Continue with Apple"), "logo-apple")
        )}
        {api.googleEnabled &&
          provider("google", tr("使用 Google 登录", "Continue with Google"), "logo-google")}
      </View>
      {!!error && (
        <Text
          testID="login-error"
          accessibilityRole="alert"
          style={{
            color: colors.amberInk,
            backgroundColor: colors.amberSurface,
            borderRadius: 14,
            overflow: "hidden",
            paddingHorizontal: 16,
            paddingVertical: 12,
            fontSize: 14,
            lineHeight: 22,
          }}
        >
          {error}
        </Text>
      )}
      <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 20 }}>
        {none
          ? tr("登录暂时不可用，请稍后重试。", "Sign-in is unavailable right now. Please try again shortly.")
          : tr(
              "和 asidefm.com 是同一个账号。",
              "The same account as asidefm.com.",
            )}
      </Text>
    </View>
  );
}
