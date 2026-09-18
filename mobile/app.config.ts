import type { ExpoConfig } from "expo/config";
export function resolveBuildEnvironment(
  env: Record<string, string | undefined>,
) {
  const local = env.APP_VARIANT !== "production";
  const testApi = env.ASIDE_TEST_API === "1";
  const apiUrl = new URL(env.EXPO_PUBLIC_API_URL ?? "https://asidefm.com");
  if (testApi && !local)
    throw new Error(
      "Test APIs cannot be used in production distribution builds.",
    );
  const loopback = ["localhost", "127.0.0.1", "[::1]", "10.0.2.2"].includes(
    apiUrl.hostname,
  );
  if (!testApi && (apiUrl.protocol !== "https:" || loopback))
    throw new Error(
      "Installable builds require a remote HTTPS API. Local acceptance requires ASIDE_TEST_API=1.",
    );
  if (
    apiUrl.username ||
    apiUrl.password ||
    apiUrl.search ||
    apiUrl.hash ||
    apiUrl.pathname !== "/"
  )
    throw new Error(
      "The API URL must be an origin without credentials, path, query or fragment.",
    );
  return { local, testApi, apiUrl: apiUrl.origin };
}
const { local, testApi, apiUrl } = resolveBuildEnvironment(process.env);
const config: ExpoConfig = {
  name: local ? "Aside Dev" : "Aside",
  slug: "aside",
  owner: "jiahangzhang",
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
        "Listen for your questions while conversation mode is on, or record a question while you hold the talk button.",
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
    apiUrl,
    testApi,
    eas: {
      projectId:
        process.env.EAS_PROJECT_ID ?? "91adc426-36cf-4264-a618-63e33b112cda",
    },
  },
  updates: { enabled: false },
};
export default config;
