import { CheckpointSync } from "@aside/player-runtime/checkpoint-sync";
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
      debugRecognition: new URLSearchParams(location.search).has("debug"),
    });
    return { audio, session };
  });
  const { session, audio } = runtime;
  const [, syncChanged] = useState(0);
  const [sync] = useState(
    () =>
      new CheckpointSync(
        {
          read: episodeLibrary.checkpoint,
          write: episodeLibrary.save,
          cache: async (id, value) => {
            try {
              localStorage.setItem(
                `aside.checkpoint.${id}`,
                JSON.stringify(value),
              );
            } catch {}
          },
        },
        () => syncChanged((n) => n + 1),
      ),
  );
  const save = () =>
    selected.current ? sync.save(session.checkpoint()) : Promise.resolve();
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => {
    savePlayerConfig(snapshot.playerConfig);
  }, [snapshot.playerConfig]);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [episodesLoading, setEpisodesLoading] = useState(true);
  const [episode, setEpisode] = useState<Episode>();
  const [uploadsEnabled, setUploadsEnabled] = useState(false);
  const [debug, setDebug] = useState(false);
  const [startingNewConversation, setStartingNewConversation] = useState(false);
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
    const version = ++loadVersion.current;
    autoplayVersion.current = null;
    session.stop();
    await save();
    if (version !== loadVersion.current) return;
    const [next, checkpoint] = await Promise.all([
      episodeLibrary.get(id),
      sync.load(id),
    ]);
    if (version !== loadVersion.current) return;
    selected.current = next;
    session.load(next, checkpoint);
    autoplayVersion.current = autoplay ? version : null;
    setEpisode(next);
  }
  useEffect(() => {
    // Selecting the same audio URL does not emit loadedmetadata again.
    if (episode && audio.isLoaded) session.metadataLoaded();
    if (episode && autoplayVersion.current === loadVersion.current) {
      autoplayVersion.current = null;
      session.start();
    }
  }, [episode, session, audio]);
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
    const pagehide = () => {
      void save().catch(() => {});
      session.stop();
    };
    const visible = () => {
      if (document.visibilityState === "visible")
        void sync.refresh().catch(() => {});
    };
    document.addEventListener("visibilitychange", visible);
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
      void save().catch(() => {});
    }, 15000);
    let previous = session.getSnapshot();
    const unsubscribe = session.subscribe(() => {
      const next = session.getSnapshot();
      if (
        next.state.mode !== previous.state.mode ||
        next.history !== previous.history
      )
        void save().catch(() => {});
      previous = next;
    });
    return () => {
      disposed = true;
      loadVersion.current++;
      clearInterval(poll);
      clearInterval(checkpoint);
      window.removeEventListener("pagehide", pagehide);
      document.removeEventListener("visibilitychange", visible);
      unsubscribe();
      session.dispose();
    };
  }, [session]);
  return {
    ...snapshot,
    checkpointConflict: sync.conflict !== undefined,
    keepLocalCheckpoint: () => {
      void sync
        .keepLocal(session.checkpoint())
        .catch((error) => session.setError(String(error)));
    },
    useRemoteCheckpoint: () => {
      const cp = sync.useRemote();
      if (cp !== undefined && selected.current) {
        session.load(selected.current, cp);
        session.metadataLoaded();
      }
    },
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
    startingNewConversation,
    async newConversation() {
      if (startingNewConversation) return;
      const version = loadVersion.current;
      setStartingNewConversation(true);
      try {
        await session.newConversation();
        if (version === loadVersion.current) await save();
      } catch (error) {
        if (version === loadVersion.current) session.setError(String(error));
      } finally {
        setStartingNewConversation(false);
      }
    },
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
      sync.reset();
      try {
        for (const key of Object.keys(localStorage))
          if (key.startsWith("aside.checkpoint.")) localStorage.removeItem(key);
      } catch {}
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
