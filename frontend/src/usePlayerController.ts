import {
  selectStore,
  selectPlayerScreen,
  samePlayerScreen,
} from "@aside/player-runtime/session-selection";
import { CheckpointSync } from "@aside/player-runtime/checkpoint-sync";
import { requestMicrophonePermission } from "./microphone";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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
  const screen = useMemo(
    () =>
      selectStore(session.getSnapshot, selectPlayerScreen, samePlayerScreen),
    [session],
  );
  const snapshot = useSyncExternalStore(session.subscribe, screen);
  useEffect(() => {
    savePlayerConfig(snapshot.playerConfig);
  }, [snapshot.playerConfig]);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const latestEpisodes = useRef(episodes);
  latestEpisodes.current = episodes;
  const [episodesLoading, setEpisodesLoading] = useState(true);
  const [episode, setEpisode] = useState<Episode>();
  const [uploadsEnabled, setUploadsEnabled] = useState(false);
  const [debug, setDebug] = useState(false);
  const [startingNewConversation, setStartingNewConversation] = useState(false);
  const selected = useRef<Episode | undefined>(undefined);
  const loadVersion = useRef(0);
  const autoplayVersion = useRef<number | null>(null);
  const microphoneAsked = useRef(false);
  const refresh = async () => {
    try {
      setEpisodes(await episodeLibrary.list());
    } finally {
      setEpisodesLoading(false);
    }
  };
  /**
   * Playing is listening: the first play of an episode asks for the microphone.
   * A refusal is reported once and the episode keeps playing; it is not asked
   * again until another episode loads.
   */
  async function listen() {
    const snapshot = session.getSnapshot();
    if (
      snapshot.listeningMode !== "off" ||
      !snapshot.configured ||
      microphoneAsked.current
    )
      return;
    microphoneAsked.current = true;
    const version = loadVersion.current;
    try {
      await requestMicrophonePermission();
    } catch {
      if (version === loadVersion.current)
        session.setError("未获得麦克风权限，仍可继续收听或打字提问。");
      return;
    }
    try {
      // The episode is already playing, so the voice connects the moment
      // listening turns on: a guest has to be verified before that.
      await prepareTrial();
    } catch (error) {
      if (version !== loadVersion.current) return;
      session.setError((error as Error).message);
      // Verification was dismissed or failed; the next play offers it again.
      microphoneAsked.current = false;
      return;
    }
    if (version === loadVersion.current && selected.current) {
      session.setError("");
      session.setListeningMode("auto");
    }
  }
  function play() {
    session.executePlayerCommand({ type: "play" });
    void listen();
  }
  async function load(id: string, autoplay = false) {
    const version = ++loadVersion.current;
    autoplayVersion.current = null;
    microphoneAsked.current = false;
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
      void listen();
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
    let polling = false;
    const pollLibrary = async (force = false) => {
      if (disposed || polling || document.hidden) return;
      const processing = (item: Episode) =>
        item.status === "queued" || item.status === "analyzing";
      const current = selected.current;
      if (
        !force &&
        !latestEpisodes.current.some(processing) &&
        !(current && processing(current))
      )
        return;
      polling = true;
      try {
        const list = await episodeLibrary.list();
        if (disposed) return;
        setEpisodes(list);
        if (current && processing(current)) {
          const next = await episodeLibrary.get(current.id);
          if (disposed || selected.current?.id !== next.id) return;
          selected.current = next;
          session.updateEpisode(next);
          setEpisode(next);
        }
      } catch {
      } finally {
        polling = false;
      }
    };
    const visible = () => {
      if (!document.hidden) {
        void sync.refresh().catch(() => {});
        void pollLibrary(true);
      }
    };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", visible);
    window.addEventListener("pagehide", pagehide);
    const poll = window.setInterval(() => void pollLibrary(), 5000);
    const checkpoint = window.setInterval(() => {
      void save().catch(() => {});
    }, 15000);
    let previousMode = session.getSnapshot().state.mode;
    let previousHistory = session.checkpoint().history;
    const unsubscribe = session.subscribe(() => {
      const next = session.getSnapshot();
      if (
        next.state.mode !== previousMode ||
        session.checkpoint().history !== previousHistory
      )
        void save().catch(() => {});
      previousMode = next.state.mode;
      previousHistory = session.checkpoint().history;
    });
    return () => {
      disposed = true;
      loadVersion.current++;
      clearInterval(poll);
      clearInterval(checkpoint);
      window.removeEventListener("pagehide", pagehide);
      window.removeEventListener("online", visible);
      document.removeEventListener("visibilitychange", visible);
      unsubscribe();
      session.dispose();
    };
  }, [session]);
  return {
    ...snapshot,
    session,
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
    microphoneLevel: () => session.microphoneLevel(),
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
    startListening: play,
    stopListening: () => session.executePlayerCommand({ type: "stop" }),
    requestResume: play,
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
