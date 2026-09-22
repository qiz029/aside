import React, { useEffect, useState } from "react";
import { ActivityIndicator, Text, View, useColorScheme } from "react-native";
import * as AppleAuthentication from "expo-apple-authentication";
import Constants from "expo-constants";
import type { MobileApi, User } from "./api";

export function AppleSignIn({
  api,
  onSignedIn,
  locale,
  linking = false,
}: {
  api: MobileApi;
  onSignedIn(user: User): Promise<void>;
  locale: string;
  linking?: boolean;
}) {
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dark = useColorScheme() === "dark";
  useEffect(() => {
    void AppleAuthentication.isAvailableAsync()
      .then(setAvailable)
      .catch(() => {});
  }, []);
  if (
    !available ||
    !api.appleEnabled ||
    !Constants.expoConfig?.extra?.appleSignInEnabled
  )
    return null;
  return (
    <View style={{ gap: 10 }}>
      {linking && (
        <Text style={{ color: dark ? "#ece5d8" : "#2b2520" }}>
          {locale === "zh"
            ? "将 Apple 绑定到当前账号，保留已有音频和进度。"
            : "Link Apple to this account to keep your existing audio and progress."}
        </Text>
      )}
      <View
        pointerEvents={busy ? "none" : "auto"}
        accessibilityState={{ busy }}
      >
        <AppleAuthentication.AppleAuthenticationButton
          buttonType={
            AppleAuthentication.AppleAuthenticationButtonType.CONTINUE
          }
          buttonStyle={
            dark
              ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
              : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
          }
          cornerRadius={14}
          style={{ height: 52, width: "100%" }}
          onPress={async () => {
            if (busy) return;
            setBusy(true);
            setError("");
            try {
              const client = Constants.expoConfig?.ios?.bundleIdentifier;
              if (!client) throw Error("Missing app identifier");
              const { nonce } = await api.appleStart(client);
              const result = await AppleAuthentication.signInAsync({
                nonce,
                requestedScopes: [
                  AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
                  AppleAuthentication.AppleAuthenticationScope.EMAIL,
                ],
              });
              if (!result.authorizationCode)
                throw Error("Apple sign-in did not complete");
              const name = result.fullName
                ? AppleAuthentication.formatFullName(result.fullName)
                : undefined;
              await onSignedIn(
                await api.appleVerify(nonce, result.authorizationCode, name),
              );
            } catch (cause) {
              if ((cause as { code?: string }).code !== "ERR_REQUEST_CANCELED")
                setError(
                  cause instanceof Error ? cause.message : String(cause),
                );
            } finally {
              setBusy(false);
            }
          }}
        />
      </View>
      {busy && <ActivityIndicator />}
      {!!error && (
        <Text
          accessibilityRole="alert"
          style={{ color: dark ? "#efbf9b" : "#875944" }}
        >
          {error}
        </Text>
      )}
    </View>
  );
}
