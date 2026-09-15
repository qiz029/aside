import type { ExpoConfig } from "expo/config";
const local = process.env.APP_VARIANT !== "production";
const config: ExpoConfig = {
  name: local ? "Aside Dev" : "Aside",
  slug: "aside",
  icon: "./assets/icon.png",
  version: "0.1.0",
  scheme: local ? "aside-dev" : "aside",
  orientation: "portrait",
  userInterfaceStyle: "automatic",
  newArchEnabled: true,
  ios: {
    supportsTablet: true,
    bundleIdentifier: local ? "com.asidefm.app.dev" : "com.asidefm.app",
    buildNumber: process.env.BUILD_NUMBER ?? "1",
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      UIFileSharingEnabled: true,
      LSSupportsOpeningDocumentsInPlace: true,
      UIBackgroundModes: ["audio"],
      NSMicrophoneUsageDescription:
        "Record a question while you hold the talk button.",
    },
  },
  android: {
    package: local ? "com.asidefm.app.dev" : "com.asidefm.app",
    versionCode: Number(process.env.BUILD_NUMBER ?? 1),
    permissions: [
      "RECORD_AUDIO",
      "FOREGROUND_SERVICE",
      "FOREGROUND_SERVICE_MEDIA_PLAYBACK",
    ],
  },
  plugins: [
    [
      "expo-audio",
      { enableBackgroundPlayback: true, enableBackgroundRecording: false },
    ],
    "expo-secure-store",
    "expo-localization",
    "./plugins/with-aside.cjs",
    ["@config-plugins/react-native-webrtc", { cameraPermission: false }],
  ],
  extra: {
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? "https://asidefm.com",
    ...(process.env.EAS_PROJECT_ID
      ? { eas: { projectId: process.env.EAS_PROJECT_ID } }
      : {}),
  },
  updates: { enabled: false },
};
export default config;
