import { NativeModules } from "react-native";
import { MediaStreamTrack } from "react-native-webrtc";

/** Native PCM track. The audio coordinator alone enables microphone input. */
export async function createSilentTrack(): Promise<MediaStreamTrack> {
  const info = await NativeModules.AsideAudioSession.createSilentTrack();
  return new MediaStreamTrack(info);
}
