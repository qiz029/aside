import "react-native-get-random-values";
import { randomUUID } from "expo-crypto";
if (!globalThis.crypto.randomUUID)
  globalThis.crypto.randomUUID =
    randomUUID as typeof globalThis.crypto.randomUUID;
import { registerRootComponent } from "expo";
import App from "./src/App";
registerRootComponent(App);
