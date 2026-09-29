import { AppState, NativeModules, Platform } from "react-native";

export function questionHeard() {
  if (Platform.OS === "ios" && AppState.currentState === "active") {
    // Older installed native clients can still load the UI without this method.
    NativeModules.AsideAudioSession?.questionHeard?.();
  }
}
