import { requestMicrophonePermission } from "./microphone";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Episode } from "@aside/engine/core";
import type { PlayerCommand, PlayerConfig } from "@aside/engine/player";
import { ListeningSession, type ListeningMode } from "./listening-session";
import { BrowserPodcastAudio } from "./podcast-audio";
import { episodeLibrary, playerBackend } from "./player-api";
import { prepareTrial } from "./trial-access";
import { loadPlayerConfig, savePlayerConfig } from "./player-preferences";
export const names = {
  paused: "已暂停",
  playing: "正在播放",
  listening: "正在听你说",
  answering: "正在回答",
  awaiting_followup: "还想聊聊吗",
  resuming: "回到音频",
  reconnecting: "连接已断开",
};
function savePreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
/** React owns the library view; the session owns all listening and question actions. */
export function usePlayerController() {
  const [runtime] = useState(() => {
    const audio = new BrowserPodcastAudio();
    const session = new ListeningSession(audio, playerBackend, {
      playerConfig: loadPlayerConfig(),
    });
    return { audio, session };
  });
  const { session, audio } = runtime;
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => {
    savePlayerConfig(snapshot.playerConfig);
  }, [snapshot.playerConfig]);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [episodesLoading, setEpisodesLoading] = useState(true);
  const [episode, setEpisode] = useState<Episode>();
  const [uploadsEnabled, setUploadsEnabled] = useState(false);
  const [debug, setDebug] = useState(false);
  const selected = useRef<Episode | undefined>(undefined);
  const loadVersion = useRef(0);
  const autoplayVersion = useRef<number | null>(null);
  const refresh = async () => {
    try {
      setEpisodes(await episodeLibrary.list());
    } finally {
      setEpisodesLoading(false);
    }
  };
  async function load(id: string, autoplay = false) {
    autoplayVersion.current = null;
    session.stop();
    const version = ++loadVersion.current;
    const [next, checkpoint] = await Promise.all([
      episodeLibrary.get(id),
      episodeLibrary.checkpoint(id),
    ]);
    if (version !== loadVersion.current) return;
    selected.current = next;
    session.load(next, checkpoint);
    autoplayVersion.current = autoplay ? version : null;
    setEpisode(next);
  }
  useEffect(() => {
    if (episode && autoplayVersion.current === loadVersion.current) {
      autoplayVersion.current = null;
      session.start();
    }
  }, [episode, session]);
  useEffect(() => {
    let disposed = false;
    void episodeLibrary
      .health()
      .then(async (health) => {
        if (!disposed) {
          session.configure(health);
          setUploadsEnabled(health.uploadsEnabled !== false);
          await refresh();
        }
      })
      .catch((error) => {
        if (!disposed) {
          setEpisodesLoading(false);
          session.setError(error.message);
        }
      });
    const pagehide = () => session.stop();
    window.addEventListener("pagehide", pagehide);
    const poll = window.setInterval(() => {
      void episodeLibrary
        .list()
        .then((list) => {
          if (!disposed) {
            setEpisodes(list);
            setEpisodesLoading(false);
          }
        })
        .catch(() => {});
      const current = selected.current;
      if (current && current.status !== "ready")
        void episodeLibrary
          .get(current.id)
          .then((next) => {
            if (disposed || selected.current?.id !== next.id) return;
            selected.current = next;
            session.updateEpisode(next);
            setEpisode(next);
          })
          .catch(() => {});
    }, 2500);
    const checkpoint = window.setInterval(() => {
      if (selected.current)
        void episodeLibrary
          .save(selected.current.id, session.checkpoint())
          .catch(() => {});
    }, 2000);
    return () => {
      disposed = true;
      loadVersion.current++;
      clearInterval(poll);
      clearInterval(checkpoint);
      window.removeEventListener("pagehide", pagehide);
      session.dispose();
    };
  }, [session]);
  return {
    ...snapshot,
    episodes,
    episodesLoading,
    episode,
    uploadsEnabled,
    debug,
    setDebug,
    audio: audio.attach,
    audioLevels: (levels: Float32Array) => audio.levels(levels),
    voiceLevels: (levels: Float32Array) => session.voiceLevels(levels),
    voiceDiagnostics: () => session.voiceDiagnostics(),
    metadataLoaded: () => session.metadataLoaded(),
    audioTick: () => session.audioTick(),
    configurePlayer: (config: Partial<PlayerConfig>) =>
      session.configurePlayer(config),
    executePlayerCommand: (command: PlayerCommand) =>
      session.executePlayerCommand(command),
    setPlaybackRate: (rate: number) => session.setPlaybackRate(rate),
    seek: (atMs: number) => session.seek(atMs),
    submitQuestion: () =>
      session.submitQuestion(session.getSnapshot().question),
    setQuestion: (text: string) => session.setQuestion(text),
    setError: (error: string) => session.setError(error),
    startListening: () => session.executePlayerCommand({ type: "play" }),
    stopListening: () => session.executePlayerCommand({ type: "stop" }),
    requestResume: () => session.executePlayerCommand({ type: "play" }),
    beginManual: () => session.beginManual(),
    endManual: () => session.endManual(),
    holdResume: () => session.holdResume(),
    changeListeningMode: (mode: ListeningMode) => {
      savePreference("aside.listeningMode", mode);
      session.setListeningMode(mode);
    },
    changeFollowupMs: (delay: number) => {
      savePreference("aside.followupMs", String(delay));
      session.setFollowupMs(delay);
    },
    load,
    async authChanged() {
      session.stop();
      selected.current = undefined;
      setEpisode(undefined);
      await refresh();
    },
    async enableMicrophone() {
      const version = loadVersion.current;
      try {
        await requestMicrophonePermission();
        if (version === loadVersion.current && selected.current) {
          session.setError("");
          session.setListeningMode("auto");
          void prepareTrial().catch((error) => {
            if (version === loadVersion.current)
              session.setError(error.message);
          });
        }
      } catch {
        if (version === loadVersion.current)
          session.setError("未获得麦克风权限，仍可继续收听或打字提问。");
      }
    },
    async playEpisode(id: string) {
      session.setListeningMode("off");
      await load(id, true);
    },
    async enter(id: string) {
      session.setListeningMode("off");
      await load(id);
    },
    async retry() {
      if (selected.current) {
        await episodeLibrary.retry(selected.current.id);
        await load(selected.current.id);
      }
    },
  };
}

export type PlayerController = ReturnType<typeof usePlayerController>;
