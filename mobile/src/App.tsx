import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  FlatList,
  Image,
  InputAccessoryView,
  KeyboardAvoidingView,
  Keyboard,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  StatusBar,
  Text,
  TextInput,
  useColorScheme,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import * as DocumentPicker from "expo-document-picker";
import Constants from "expo-constants";
import { File } from "expo-file-system";
import { Ionicons } from "@expo/vector-icons";
import Slider from "@react-native-community/slider";
import { getLocales } from "expo-localization";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Episode } from "@aside/engine/core";
import { ListeningSession } from "@aside/player-runtime/listening-session";
import { CheckpointSync } from "@aside/player-runtime/checkpoint-sync";
import { MobileApi, type User, type AudioFile } from "./api";
import {
  AudioCoordinator,
  NativePodcastAudio,
  microphonePermission,
} from "./audio";
import { nativeVoiceFactory } from "./voice";
import { restoreAccount } from "./account-session";
import { LoginForm } from "./LoginForm";
import { errorMessage } from "./error-message";
import { observeAcceptance } from "./acceptance-observer";
const formatTime = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
function Main() {
  const dark = useColorScheme() === "dark";
  const colors = {
    background: dark ? "#111612" : "#f0f1ed",
    surface: dark ? "#202721" : "#fffefa",
    navigation: dark ? "#19201b" : "#fffefa",
    text: dark ? "#f0f2eb" : "#202a23",
    muted: dark ? "#adb8ad" : "#68746b",
    accent: dark ? "#a7cbb3" : "#315b43",
    onAccent: dark ? "#1a281e" : "#ffffff",
    highlight: dark ? "#2a3b30" : "#e1eadf",
    line: dark ? "#344037" : "#d9dfd7",
  };
  const [locale, setLocale] = useState(
    getLocales()[0]?.languageCode === "zh" ? "zh" : "en",
  );
  const tr = (zh: string, en: string) => (locale === "zh" ? zh : en);
  const [tab, setTab] = useState<"library" | "upload" | "account">("library");
  const [pane, setPane] = useState<"transcript" | "conversation">("transcript");
  const [collection, setCollection] = useState<"public" | "private">("public");
  const [user, setUser] = useState<User | null>(null),
    [episodes, setEpisodes] = useState<Episode[]>([]),
    [privateEpisodes, setPrivateEpisodes] = useState<Episode[]>([]);
  const [cursor, setCursor] = useState<string | null>(null),
    [episode, setEpisode] = useState<Episode | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [accountState, setAccountState] = useState<
    "checking" | "ready" | "unavailable"
  >("checking");
  const [startupFailed, setStartupFailed] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [playerOptions, setPlayerOptions] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  useEffect(() => setComposerOpen(false), [episode?.id]);
  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      () => setKeyboardVisible(true),
    );
    const hide = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => setKeyboardVisible(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  const startup = useRef({ revision: 0, failed: false });
  const [upload, setUpload] = useState<{
    name: string;
    progress: number;
    phase: string;
  } | null>(null);
  const [lastId, setLastId] = useState<string | null>(null),
    [rate, setRate] = useState(1);
  const [, updateSync] = useState(0);
  const [runtime] = useState(() => {
    const api = new MobileApi(),
      coordinator = new AudioCoordinator(),
      audio = new NativePodcastAudio(coordinator);
    const session = new ListeningSession(audio, api, {
      mode: "manual",
      spokenResume: "verified",
      followupMs: 3000,
      speechYield: "duck",
      voiceFactory: nativeVoiceFactory(coordinator),
    });
    const sync = new CheckpointSync(
      {
        read: (id) => api.checkpoint(id),
        write: (id, value) => api.save(id, value),
        cache: async (id, value) => {
          if (api.token)
            await AsyncStorage.setItem(
              `aside.checkpoint.${id}`,
              JSON.stringify(value),
            );
        },
      },
      () => updateSync((n) => n + 1),
    );
    return { api, audio, session, sync };
  });
  const { api, audio, session, sync } = runtime;
  useEffect(() => {
    if (Constants.expoConfig?.extra?.testApi !== true) return;
    return observeAcceptance(session, api.base, Platform.OS, () => ({
      playing: audio.player.playing,
      positionMs: audio.positionMs,
      volume: audio.player.volume,
    }));
  }, [api, audio, session]);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [inputLevel, setInputLevel] = useState(0);
  useEffect(() => {
    if (snapshot.listeningMode !== "auto" || snapshot.liveStatus !== "on") {
      setInputLevel(0);
      return;
    }
    const timer = setInterval(
      () => setInputLevel(session.microphoneLevel()),
      100,
    );
    return () => clearInterval(timer);
  }, [session, snapshot.listeningMode, snapshot.liveStatus]);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  useEffect(() => {
    setRecordingSeconds(0);
    if (!snapshot.manualHeld || snapshot.liveStatus !== "armed") return;
    const start = Date.now();
    const timer = setInterval(
      () =>
        setRecordingSeconds(
          Math.min(30, Math.floor((Date.now() - start) / 1000)),
        ),
      250,
    );
    return () => clearInterval(timer);
  }, [snapshot.manualHeld, snapshot.liveStatus]);
  const [followTranscript, setFollowTranscript] = useState(true);
  const transcriptRef = useRef<FlatList>(null),
    chatRef = useRef<FlatList>(null),
    pressVersion = useRef(0),
    held = useRef(false);
  const captureStart = useRef({ x: 0, y: 0 });
  const [captureCancelled, setCaptureCancelled] = useState(false);
  const questionInput = useRef<TextInput>(null);
  const followConversation = useRef(true);
  const lastAcceptedQuestion = useRef<string | undefined>(undefined);
  useEffect(() => {
    const last = snapshot.history.findLast((turn) => turn.role === "user");
    const id = last?.id ?? last?.text;
    if (
      id &&
      id !== lastAcceptedQuestion.current &&
      snapshot.listeningMode === "auto" &&
      snapshot.state.interruption
    ) {
      followConversation.current = true;
      setPane("conversation");
    }
    lastAcceptedQuestion.current = id;
  }, [snapshot.history, snapshot.listeningMode, snapshot.state.interruption]);
  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        if (tab !== "library") {
          setTab("library");
          return true;
        }
        if (composerOpen) {
          Keyboard.dismiss();
          setComposerOpen(false);
          return true;
        }
        if (episode) {
          setEpisode(null);
          return true;
        }
        return false;
      },
    );
    return () => subscription.remove();
  }, [tab, episode, composerOpen]);
  const lastUpload = useRef<AudioFile | null>(null);
  const current = useRef<Episode | null>(null),
    uploadAbort = useRef<AbortController | null>(null),
    generation = useRef(0),
    appState = useRef(AppState.currentState);
  const initialSeek = useRef<string | null>(null);
  const failure = (cause: unknown) =>
    setError(cause instanceof Error ? cause.message : String(cause));
  const run = (action: () => Promise<unknown>) => {
    Keyboard.dismiss();
    setError("");
    void action().catch(failure);
  };
  const save = async () => {
    if (current.current && api.token) await sync.save(session.checkpoint());
  };
  function clearUploadFile() {
    const previous = lastUpload.current;
    lastUpload.current = null;
    if (previous) {
      const file = new File(previous.uri);
      if (file.exists) file.delete();
    }
  }
  async function clearAccount() {
    uploadAbort.current?.abort();
    clearUploadFile();
    generation.current++;
    session.stop();
    audio.clear();
    current.current = null;
    setEpisode(null);
    setUser(null);
    setPrivateEpisodes([]);
    sync.reset();
    setCollection("public");
    const keys = await AsyncStorage.getAllKeys();
    await AsyncStorage.multiRemove(
      keys.filter((k) => k.startsWith("aside.checkpoint.")),
    );
    await api.forget();
  }
  async function refreshApplication() {
    const revision = ++startup.current.revision;
    setLoading(true);
    setAccountState("checking");
    setError("");
    const results = await Promise.allSettled([
      restoreAccount(api),
      api.health(),
      api.list(),
    ]);
    if (revision !== startup.current.revision) return;
    const [account, health, library] = results;
    let failed = results.find((result) => result.status === "rejected");
    if (health.status === "fulfilled") session.configure(health.value);
    if (library.status === "fulfilled") setEpisodes(library.value);
    if (account.status === "fulfilled") {
      setUser(account.value);
      setAccountState("ready");
      if (account.value) {
        setCollection("private");
        try {
          await refreshPrivate();
        } catch (cause) {
          failed = { status: "rejected", reason: cause };
        }
      }
    } else {
      setAccountState("unavailable");
    }
    if (revision !== startup.current.revision) return;
    startup.current.failed = Boolean(failed);
    setStartupFailed(Boolean(failed));
    if (failed?.status === "rejected") failure(failed.reason);
    setLoading(false);
  }
  async function refreshPrivate(next?: string) {
    if (!api.token) return;
    const token = api.token;
    const page = await api.space(next);
    if (token !== api.token) return;
    setPrivateEpisodes((old) =>
      next ? [...old, ...page.episodes] : page.episodes,
    );
    setCursor(page.nextCursor);
  }
  async function load(id: string) {
    await save();
    const revision = ++generation.current;
    session.stop();
    setError("");
    setLoading(true);
    try {
      const [next, cp] = await Promise.all([
        api.episode(id),
        api.token ? sync.load(id) : Promise.resolve(null),
      ]);
      if (revision !== generation.current) return;
      current.current = next;
      setEpisode(next);
      session.load(next, cp);
      initialSeek.current = null;
      audio.load(
        api.base + `/api/episodes/${id}/audio`,
        api.headers(),
        next.title,
      );
      setLastId(id);
      await AsyncStorage.setItem("aside.lastEpisode", id);
      setPane("transcript");
      setFollowTranscript(true);
      setTab("library");
    } finally {
      if (revision === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    let disposed = false;
    api.onExpired = () => {
      void clearAccount();
      setError(
        tr("登录已过期，请重新登录", "Session expired. Please sign in again."),
      );
    };
    void (async () => {
      const savedLocale = await AsyncStorage.getItem("aside.locale");
      if (savedLocale) setLocale(savedLocale);
      setLastId(await AsyncStorage.getItem("aside.lastEpisode"));
      const wait = await AsyncStorage.getItem("aside.followupMs");
      if (wait !== null && [0, 3000, 8000].includes(Number(wait)))
        session.setFollowupMs(Number(wait));
      if (disposed) return;
      await refreshApplication();
    })()
      .catch(failure)
      .finally(() => setLoading(false));
    let previousMode = session.getSnapshot().state.mode,
      previousHistory = session.checkpoint().history;
    const unsubscribe = session.subscribe(() => {
      const next = session.getSnapshot();
      const completedHistory = session.checkpoint().history;
      if (
        next.state.mode !== previousMode ||
        completedHistory !== previousHistory
      ) {
        previousMode = next.state.mode;
        previousHistory = completedHistory;
        void save().catch(failure);
      }
    });
    const nativeSubscription = audio.player.addListener(
      "playbackStatusUpdate",
      (status) => {
        if (!current.current) return;
        if (status.isLoaded && audio.player.isLoaded) {
          if (initialSeek.current !== current.current.id) {
            initialSeek.current = current.current.id;
            session.metadataLoaded();
          }
          session.audioTick();
        }
        if (status.didJustFinish) session.stop();
        const mode = session.getSnapshot().state.mode;
        const command = audio.events.observe(status);
        if (command === "pause" && mode === "playing") session.stop();
        if (command === "play" && mode === "paused") session.start();
      },
    );
    const stateSubscription = AppState.addEventListener("change", (state) => {
      const before = appState.current;
      appState.current = state;
      if (state !== "active") {
        uploadAbort.current?.abort();
        session.background();
        void save().catch(failure);
      } else if (before !== "active") {
        if (startup.current.failed) {
          void refreshApplication();
          return;
        }
        session.audioTick();
        void (async () => {
          await save();
          await sync.refresh();
          await refreshPrivate();
        })().catch(failure);
      }
    });
    const interval = setInterval(() => {
      if (appState.current === "active") void save().catch(failure);
    }, 15000);
    const polling = setInterval(() => {
      const e = current.current;
      if (e && e.status !== "ready")
        void api
          .episode(e.id)
          .then((next) => {
            if (current.current?.id === next.id) {
              current.current = next;
              setEpisode(next);
              session.updateEpisode(next);
            }
          })
          .catch(failure);
    }, 2500);
    return () => {
      disposed = true;
      startup.current.revision++;
      clearInterval(interval);
      clearInterval(polling);
      stateSubscription.remove();
      nativeSubscription.remove();
      unsubscribe();
      session.dispose();
      audio.dispose();
    };
  }, []);
  const passageIndex =
    episode?.analysis?.passages.findIndex(
      (p) =>
        snapshot.state.positionMs >= p.startMs &&
        snapshot.state.positionMs < p.endMs,
    ) ?? -1;
  const scrollToCurrentPassage = () => {
    if (followTranscript && passageIndex >= 0 && pane === "transcript")
      transcriptRef.current?.scrollToIndex({
        index: passageIndex,
        animated: true,
        viewPosition: 0.25,
      });
  };
  useEffect(() => {
    scrollToCurrentPassage();
  }, [passageIndex, pane, followTranscript]);
  async function login(email: string, code: string) {
    setError("");
    const next = await api.verify(email, code);
    setUser(next);
    setCollection("private");
    setTab("library");
    try {
      await refreshPrivate();
      if (current.current) {
        const cp = await sync.load(current.current.id);
        session.load(current.current, cp);
        session.metadataLoaded();
      }
    } catch (cause) {
      failure(cause);
    }
  }
  async function selectUpload() {
    if (!user) {
      setTab("account");
      return;
    }
    const result = await DocumentPicker.getDocumentAsync({
      type: "audio/*",
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    const file: AudioFile = {
      uri: asset.uri,
      name: asset.name,
      mimeType: asset.mimeType ?? "application/octet-stream",
      size: asset.size ?? 0,
    };
    if (!file.size)
      throw Error(tr("无法读取文件大小", "Cannot read file size"));
    clearUploadFile();
    lastUpload.current = file;
    await uploadFile(file);
  }
  async function uploadFile(file: AudioFile) {
    const revision = generation.current;
    const abort = new AbortController();
    uploadAbort.current = abort;
    setUpload({ name: file.name, progress: 0, phase: "uploading" });
    try {
      const next = await api.upload(file, abort.signal, (progress, phase) => {
        if (phase === "processing") uploadAbort.current = null;
        setUpload({ name: file.name, progress, phase });
      });
      if (revision !== generation.current) return;
      clearUploadFile();
      await refreshPrivate();
      await load(next.id);
    } catch (error) {
      if (abort.signal.aborted)
        throw new Error(
          tr(
            "上传已取消。点击重试，并在上传期间保持 App 在前台。",
            "Upload cancelled. Tap Retry upload and keep the app open.",
          ),
        );
      throw error;
    } finally {
      uploadAbort.current = null;
      setUpload(null);
    }
  }
  const toggleConversation = () => {
    if (snapshot.listeningMode === "auto" && snapshot.liveStatus !== "off") {
      session.setListeningMode("manual");
      return;
    }
    if (!user) {
      setTab("account");
      return;
    }
    void (async () => {
      if (!(await microphonePermission())) {
        setError(
          tr(
            "允许麦克风后，点「开启随时聊」",
            "After allowing microphone access, tap Talk hands-free",
          ),
        );
        return;
      }
      await session.enableContinuous();
    })().catch(failure);
  };
  const button = (
    label: string,
    action: () => void,
    testID?: string,
    secondary = false,
    unavailable = false,
  ) => {
    const disabled =
      unavailable ||
      (testID === "send-question" &&
        (!snapshot.question.trim() || snapshot.busy));
    const segmented = [
      "show-transcript",
      "show-conversation",
      "private-library",
      "public-library",
    ].includes(testID ?? "");
    const icon = (
      {
        "back-library": "chevron-back",
        "player-options": "ellipsis-horizontal",
        "send-question": "arrow-up",
        question: "create-outline",
        "close-question": "close",
        "seek-back": "play-back",
        "seek-forward": "play-forward",
        "play-toggle": snapshot.state.mode === "playing" ? "pause" : "play",
      } as const
    )[testID as "play-toggle"];
    const transport = [
      "seek-back",
      "seek-forward",
      "speed",
      "back-library",
      "player-options",
      "question",
      "close-question",
    ].includes(testID ?? "");
    const foreground =
      secondary || segmented || transport ? colors.text : colors.onAccent;
    return (
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={
          segmented || testID?.startsWith("followup-")
            ? { selected: !secondary }
            : {
                disabled,
              }
        }
        disabled={disabled}
        onPress={action}
        style={({ pressed }) => [
          styles.button,
          segmented && styles.segment,
          testID === "continue-last" && { marginHorizontal: 24, marginTop: 12 },
          transport && styles.transport,
          testID === "play-toggle" && styles.playButton,
          testID === "send-question" && styles.sendButton,
          {
            backgroundColor: segmented
              ? !secondary
                ? colors.highlight
                : "transparent"
              : transport
                ? "transparent"
                : secondary
                  ? colors.surface
                  : colors.accent,
            borderColor:
              secondary && !segmented && !transport
                ? colors.line
                : "transparent",
            opacity: disabled ? 0.35 : pressed ? 0.65 : 1,
            transform: [{ scale: pressed ? 0.97 : 1 }],
          },
        ]}
      >
        {icon ? (
          <Ionicons
            name={icon}
            size={testID === "play-toggle" ? 27 : 21}
            color={foreground}
          />
        ) : null}
        {!icon || testID === "seek-back" || testID === "seek-forward" ? (
          <Text
            maxFontSizeMultiplier={1.5}
            style={{
              color: foreground,
              fontWeight: "600",
              fontSize: transport ? 12 : 14,
            }}
          >
            {label}
          </Text>
        ) : null}
      </Pressable>
    );
  };
  const rawError = error || snapshot.error;
  const microphoneDenied =
    /Microphone permission denied|Recording permission has not been granted/i.test(
      rawError,
    );
  const visibleError = errorMessage(rawError, locale);
  const textStyle = { color: colors.text };
  const list = collection === "private" ? privateEpisodes : episodes;
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.navigation }]}>
      <StatusBar barStyle={dark ? "light-content" : "dark-content"} />
      <KeyboardAvoidingView
        style={[styles.root, { backgroundColor: colors.background }]}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        {!keyboardVisible && !(episode && tab === "library") ? (
          <View
            style={[
              styles.header,
              {
                backgroundColor: colors.navigation,
                borderBottomColor: colors.line,
              },
            ]}
          >
            <Text
              maxFontSizeMultiplier={1}
              style={[styles.brand, { color: colors.accent }]}
            >
              Aside.
            </Text>
            <Ionicons name="headset-outline" size={22} color={colors.accent} />
          </View>
        ) : null}
        {error || snapshot.error ? (
          <View
            style={[
              styles.notice,
              styles.errorNotice,
              { backgroundColor: colors.surface, borderColor: colors.line },
            ]}
          >
            <Text
              accessibilityRole="alert"
              style={{
                color: colors.text,
                flex: 1,
                fontSize: 13,
                lineHeight: 19,
              }}
            >
              {visibleError}
            </Text>
            {microphoneDenied
              ? button(
                  tr("设置", "Settings"),
                  () => run(() => Linking.openSettings()),
                  "microphone-settings",
                  true,
                )
              : null}
            {startupFailed && !loading
              ? button(
                  tr("重试", "Retry"),
                  () => {
                    void refreshApplication();
                  },
                  "retry-connection",
                  true,
                )
              : null}
            {button(
              tr("关闭", "Dismiss"),
              () => {
                setError("");
                session.setError("");
              },
              "dismiss-error",
              true,
            )}
          </View>
        ) : null}
        {sync.conflict !== undefined ? (
          <View
            style={[
              styles.notice,
              { backgroundColor: colors.highlight, flexDirection: "column" },
            ]}
          >
            <Text style={textStyle}>
              {tr(
                "另一台设备更新了进度",
                "Another device updated your progress",
              )}
            </Text>
            <View style={styles.row}>
              {button(
                tr("继续本机", "Keep this device"),
                () => run(() => sync.keepLocal(session.checkpoint())),
                "keep-local",
              )}
              {button(
                tr("接着另一设备听", "Use other device"),
                () => {
                  const cp = sync.useRemote();
                  if (cp !== undefined && episode) {
                    session.load(episode, cp);
                    session.metadataLoaded();
                  }
                },
                "use-remote",
                true,
              )}
            </View>
          </View>
        ) : null}
        {tab === "account" ? (
          <ScrollView
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          >
            <Text
              maxFontSizeMultiplier={1.35}
              style={[styles.title, textStyle]}
            >
              {tr("我的", "Account")}
            </Text>
            {!keyboardVisible ? (
              <View style={styles.row}>
                {button(
                  "中文",
                  () => {
                    setLocale("zh");
                    void AsyncStorage.setItem("aside.locale", "zh");
                  },
                  "locale-zh",
                  locale !== "zh",
                )}
                {button(
                  "English",
                  () => {
                    setLocale("en");
                    void AsyncStorage.setItem("aside.locale", "en");
                  },
                  "locale-en",
                  locale !== "en",
                )}
              </View>
            ) : null}
            {Constants.expoConfig?.extra?.testApi ? (
              <Text
                testID="test-environment"
                style={{ color: colors.muted, lineHeight: 22 }}
              >
                {tr(
                  "本地验收环境 · 使用测试验证码，数据不与网站同步。",
                  "Local test environment · Test codes only. Data does not sync with the website.",
                )}
              </Text>
            ) : null}
            {user ? (
              <>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 16,
                    paddingVertical: 12,
                  }}
                >
                  <View
                    style={{
                      width: 56,
                      height: 56,
                      borderRadius: 28,
                      backgroundColor: colors.highlight,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 24,
                        fontWeight: "600",
                        color: colors.accent,
                      }}
                    >
                      {user.alias.slice(0, 1).toUpperCase()}
                    </Text>
                  </View>
                  <View style={{ flex: 1, gap: 5 }}>
                    <Text
                      maxFontSizeMultiplier={1.6}
                      style={[styles.subtitle, textStyle]}
                    >
                      {user.alias}
                    </Text>
                    <Text style={{ color: colors.muted, fontSize: 14 }}>
                      {user.email}
                    </Text>
                  </View>
                </View>
                {user.description ? (
                  <Text style={[textStyle, { lineHeight: 24 }]}>
                    {user.description}
                  </Text>
                ) : null}
                {button(
                  tr("编辑网页版资料", "Edit profile on web"),
                  () => run(() => Linking.openURL(api.base + "/space")),
                  "edit-profile",
                  true,
                )}
                {button(
                  tr("退出登录", "Sign out"),
                  () =>
                    run(async () => {
                      await save().catch(() => {});
                      try {
                        await api.logout();
                      } finally {
                        await clearAccount();
                      }
                    }),
                  "sign-out",
                  true,
                )}
              </>
            ) : accountState === "checking" ? (
              <ActivityIndicator
                accessibilityLabel={tr("正在恢复登录", "Restoring sign-in")}
              />
            ) : accountState === "unavailable" ? (
              <View style={{ gap: 16 }}>
                <Text style={{ color: colors.muted, lineHeight: 24 }}>
                  {tr(
                    "暂时无法连接。连接恢复后，你可以继续使用原账号。",
                    "We couldn’t connect. Your account will be available when the connection returns.",
                  )}
                </Text>
                {button(
                  tr("重新连接", "Reconnect"),
                  () => {
                    void refreshApplication();
                  },
                  "retry-account",
                )}
              </View>
            ) : (
              <LoginForm
                locale={locale}
                colors={colors}
                sendCode={(email) => api.startLogin(email)}
                signIn={login}
              />
            )}
          </ScrollView>
        ) : tab === "upload" ? (
          <ScrollView
            contentContainerStyle={[styles.content, { paddingTop: 32 }]}
            keyboardShouldPersistTaps="handled"
          >
            <View
              style={[styles.uploadArt, { backgroundColor: colors.highlight }]}
            >
              <Ionicons
                name="cloud-upload-outline"
                size={44}
                color={colors.accent}
              />
            </View>
            <Text
              maxFontSizeMultiplier={1.35}
              style={[styles.title, textStyle]}
            >
              {tr("上传音频", "Upload audio")}
            </Text>
            <Text style={{ color: colors.muted }}>
              {tr(
                "单篇最长 5 小时、最大 1 GiB。上传期间请留在 App。",
                "Up to 5 hours and 1 GiB. Keep the app open while uploading.",
              )}
            </Text>
            {upload ? (
              <>
                <Text style={textStyle}>{upload.name}</Text>
                <Text style={textStyle}>
                  {upload.phase === "processing"
                    ? tr("正在提交分析…", "Starting analysis…")
                    : `${Math.round(upload.progress * 100)}%`}
                </Text>
                <View
                  accessibilityRole="progressbar"
                  accessibilityValue={{
                    min: 0,
                    max: 100,
                    now: Math.round(upload.progress * 100),
                  }}
                  style={{
                    height: 5,
                    backgroundColor: colors.line,
                    borderRadius: 3,
                    overflow: "hidden",
                  }}
                >
                  <View
                    style={{
                      height: 5,
                      width: `${upload.progress * 100}%`,
                      backgroundColor: colors.accent,
                    }}
                  />
                </View>
                {uploadAbort.current
                  ? button(
                      tr("取消上传", "Cancel upload"),
                      () => uploadAbort.current?.abort(),
                      "cancel-upload",
                      true,
                    )
                  : null}
              </>
            ) : (
              button(
                tr("选择音频文件", "Choose audio file"),
                () => run(selectUpload),
                "choose-audio",
              )
            )}
            {!upload && lastUpload.current
              ? button(
                  tr("重试上传", "Retry upload"),
                  () => run(() => uploadFile(lastUpload.current!)),
                  "retry-upload",
                  true,
                )
              : null}
          </ScrollView>
        ) : episode ? (
          <>
            <View
              style={[
                styles.playerHeader,
                {
                  backgroundColor: colors.navigation,
                  borderBottomColor: colors.line,
                },
              ]}
            >
              {button(
                tr("返回音频库", "Library"),
                () => {
                  setEpisode(null);
                },
                "back-library",
                true,
              )}
              {episode.cover ? (
                <Image
                  accessibilityLabel="Episode artwork"
                  source={{
                    uri: api.base + `/api/episodes/${episode.id}/cover`,
                    headers: api.headers(),
                  }}
                  style={{ width: 48, height: 48, borderRadius: 8 }}
                />
              ) : (
                <View
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: 8,
                    backgroundColor: colors.highlight,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Ionicons
                    name="musical-notes-outline"
                    size={22}
                    color={colors.accent}
                  />
                </View>
              )}
              <View style={{ flex: 1, gap: 3 }}>
                <Text
                  numberOfLines={1}
                  maxFontSizeMultiplier={1.35}
                  style={{
                    color: colors.muted,
                    fontSize: 10,
                    fontWeight: "700",
                    letterSpacing: 1.2,
                  }}
                >
                  {tr("正在收听", "NOW LISTENING")}
                </Text>
                <Text
                  numberOfLines={2}
                  maxFontSizeMultiplier={1.6}
                  style={[styles.subtitle, textStyle]}
                >
                  {episode.title}
                </Text>
              </View>
              {button(
                tr("播放与对话选项", "Playback and conversation options"),
                () => setPlayerOptions(true),
                "player-options",
                true,
              )}
            </View>
            {episode.status !== "ready" ? (
              <View style={styles.content}>
                <Text style={textStyle}>
                  {episode.stage} · {Math.round(episode.progress * 100)}%
                </Text>
                {episode.error ? (
                  <Text style={{ color: colors.accent }}>{episode.error}</Text>
                ) : (
                  <ActivityIndicator />
                )}
                {episode.status === "failed"
                  ? button(
                      tr("重试分析", "Retry analysis"),
                      () => run(() => api.retry(episode.id)),
                      "retry-analysis",
                    )
                  : null}
              </View>
            ) : (
              <>
                <View
                  style={[
                    styles.row,
                    styles.paneTabs,
                    {
                      backgroundColor: colors.navigation,
                      borderBottomColor: colors.line,
                    },
                  ]}
                >
                  {button(
                    tr("逐字稿", "Transcript"),
                    () => setPane("transcript"),
                    "show-transcript",
                    pane !== "transcript",
                  )}
                  {button(
                    tr("对话", "Conversation"),
                    () => setPane("conversation"),
                    "show-conversation",
                    pane !== "conversation",
                  )}
                </View>
                {pane === "transcript" && !followTranscript
                  ? button(
                      tr("回到正在播放的段落", "Back to current passage"),
                      () => setFollowTranscript(true),
                      "follow-transcript",
                      true,
                    )
                  : null}
                {pane === "transcript" ? (
                  <FlatList
                    ref={transcriptRef}
                    onLayout={scrollToCurrentPassage}
                    onContentSizeChange={scrollToCurrentPassage}
                    onScrollToIndexFailed={({ averageItemLength, index }) =>
                      transcriptRef.current?.scrollToOffset({
                        offset: averageItemLength * index,
                        animated: true,
                      })
                    }
                    testID="transcript"
                    onScrollBeginDrag={() => setFollowTranscript(false)}
                    data={episode.analysis?.passages ?? []}
                    keyExtractor={(p) => p.id}
                    contentContainerStyle={styles.content}
                    renderItem={({ item }) => (
                      <Pressable
                        onPress={() => {
                          session.seek(item.startMs);
                          session.start();
                        }}
                        style={[
                          styles.passage,
                          {
                            backgroundColor:
                              snapshot.state.positionMs >= item.startMs &&
                              snapshot.state.positionMs < item.endMs
                                ? colors.surface
                                : "transparent",
                          },
                        ]}
                      >
                        <Text style={{ color: colors.accent, fontSize: 12 }}>
                          {formatTime(item.startMs)}
                        </Text>
                        <Text style={[textStyle, styles.transcript]}>
                          {item.text}
                        </Text>
                      </Pressable>
                    )}
                  />
                ) : (
                  <FlatList
                    ref={chatRef}
                    inverted
                    onContentSizeChange={() =>
                      followConversation.current &&
                      chatRef.current?.scrollToOffset({
                        offset: 0,
                        animated: false,
                      })
                    }
                    onLayout={() => {
                      if (followConversation.current)
                        chatRef.current?.scrollToOffset({
                          offset: 0,
                          animated: false,
                        });
                    }}
                    onScrollBeginDrag={() => {
                      followConversation.current = false;
                    }}
                    onScrollEndDrag={({ nativeEvent }) => {
                      followConversation.current =
                        nativeEvent.contentOffset.y < 80;
                    }}
                    onMomentumScrollEnd={({ nativeEvent }) => {
                      // iOS also emits this after a nonanimated scrollToOffset.
                      // Only a user drag may turn following off. Momentum may
                      // restore following after the user reaches the bottom.
                      if (followConversation.current) return;
                      followConversation.current =
                        nativeEvent.contentOffset.y < 80;
                    }}
                    scrollEventThrottle={100}
                    testID="conversation"
                    // The newest variable-height item is always at offset 0;
                    // scrolling to an estimated unmeasured end can hide replies.
                    data={[...snapshot.history].reverse()}
                    keyExtractor={(turn, i) =>
                      turn.id ?? String(snapshot.history.length - i - 1)
                    }
                    contentContainerStyle={styles.content}
                    ListEmptyComponent={
                      <View style={styles.emptyConversation}>
                        <Ionicons
                          name="chatbubbles-outline"
                          size={30}
                          color={colors.accent}
                        />
                        <Text style={[styles.subtitle, textStyle]}>
                          {tr("聊聊刚才听到的", "A little room to talk")}
                        </Text>
                        <Text
                          style={{
                            color: colors.muted,
                            textAlign: "center",
                            lineHeight: 23,
                          }}
                        >
                          {tr(
                            "对刚才听到的内容，有什么好奇？",
                            "What caught your curiosity?",
                          )}
                        </Text>
                      </View>
                    }
                    ListHeaderComponent={
                      snapshot.busy ? (
                        <View
                          testID="answer-stream"
                          style={[
                            styles.bubble,
                            {
                              backgroundColor: colors.surface,
                              borderColor: colors.line,
                              borderWidth: StyleSheet.hairlineWidth,
                            },
                          ]}
                        >
                          <View
                            style={{
                              flexDirection: "row",
                              alignItems: "center",
                              gap: 8,
                            }}
                          >
                            <Text
                              style={{
                                color: colors.accent,
                                fontSize: 12,
                                fontWeight: "700",
                              }}
                            >
                              Aside
                            </Text>
                            <ActivityIndicator
                              size="small"
                              color={colors.accent}
                            />
                          </View>
                          <Text style={[textStyle, styles.transcript]}>
                            {snapshot.answerPreview ||
                              tr("正在想一想…", "Thinking it through…")}
                          </Text>
                        </View>
                      ) : null
                    }
                    renderItem={({ item }) => (
                      <View
                        style={[
                          styles.bubble,
                          {
                            backgroundColor:
                              item.role === "user"
                                ? colors.highlight
                                : colors.surface,
                            marginLeft: item.role === "user" ? 36 : 0,
                            marginRight: item.role === "user" ? 0 : 12,
                          },
                        ]}
                      >
                        <Text style={{ color: colors.accent, fontSize: 12 }}>
                          {item.role === "user" ? tr("你", "You") : "Aside"}
                        </Text>
                        <Text style={[textStyle, styles.transcript]}>
                          {item.text}
                        </Text>
                      </View>
                    )}
                  />
                )}
                <View
                  style={[
                    styles.controls,
                    {
                      borderColor: colors.line,
                      backgroundColor: colors.surface,
                    },
                  ]}
                >
                  <View style={{ display: keyboardVisible ? "none" : "flex" }}>
                    <Slider
                      testID="progress"
                      accessibilityLabel={tr("播放进度", "Playback position")}
                      minimumValue={0}
                      maximumValue={episode.durationMs}
                      value={snapshot.state.positionMs}
                      minimumTrackTintColor={colors.accent}
                      maximumTrackTintColor={colors.line}
                      thumbTintColor={colors.accent}
                      onSlidingComplete={(value) => {
                        session.seek(value);
                        session.start();
                      }}
                    />
                    <View style={styles.timeRow}>
                      <Text
                        testID="playback-position"
                        maxFontSizeMultiplier={1.5}
                        style={{
                          color: colors.muted,
                          fontSize: 11,
                          fontVariant: ["tabular-nums"],
                        }}
                      >
                        {formatTime(snapshot.state.positionMs)}
                      </Text>
                      <Text
                        maxFontSizeMultiplier={1.5}
                        style={{
                          color: colors.muted,
                          fontSize: 11,
                          fontVariant: ["tabular-nums"],
                        }}
                      >
                        −
                        {formatTime(
                          Math.max(
                            0,
                            episode.durationMs - snapshot.state.positionMs,
                          ),
                        )}
                      </Text>
                    </View>
                    <View style={[styles.row, { paddingHorizontal: 48 }]}>
                      {button(
                        "−15",
                        () => {
                          session.seek(Math.max(0, audio.positionMs - 15000));
                          session.start();
                        },
                        "seek-back",
                        true,
                      )}
                      {button(
                        snapshot.state.mode === "playing"
                          ? tr("暂停", "Pause")
                          : tr("播放", "Play"),
                        () =>
                          snapshot.state.mode === "playing"
                            ? session.stop()
                            : session.start(),
                        "play-toggle",
                      )}
                      {button(
                        "+15",
                        () => {
                          session.seek(
                            Math.min(
                              episode.durationMs,
                              audio.positionMs + 15000,
                            ),
                          );
                          session.start();
                        },
                        "seek-forward",
                        true,
                      )}
                      <View style={{ position: "absolute", right: 0 }}>
                        {button(
                          `${rate}×`,
                          () => {
                            const next = rate >= 2 ? 0.75 : rate + 0.25;
                            setRate(next);
                            session.setPlaybackRate(next);
                          },
                          "speed",
                          true,
                        )}
                      </View>
                    </View>
                    {snapshot.state.interruption && (
                      <View style={styles.resumeBar}>
                        <Text
                          testID={
                            snapshot.resumeSeconds === null &&
                            (snapshot.resumeHeld ||
                              snapshot.resumeNeedsConfirmation)
                              ? "manual-resume-hint"
                              : undefined
                          }
                          style={{
                            color: colors.muted,
                            fontSize: 12,
                            flexGrow: 1,
                            flexBasis: 95,
                          }}
                        >
                          {snapshot.resumeSeconds !== null
                            ? tr(
                                `${snapshot.resumeSeconds} 秒后继续`,
                                `Resuming in ${snapshot.resumeSeconds}s`,
                              )
                            : snapshot.resumeHeld ||
                                snapshot.resumeNeedsConfirmation
                              ? tr(
                                  "已暂停 · 随时继续听",
                                  "Paused · continue when ready",
                                )
                              : tr("节目已暂停", "Podcast paused")}
                        </Text>
                        {button(
                          tr("继续听", "Continue"),
                          () => session.start(),
                          "resume",
                          true,
                        )}
                        {!snapshot.resumeHeld &&
                          button(
                            tr("先别继续", "Wait"),
                            () => session.holdResume(),
                            "hold",
                            true,
                          )}
                      </View>
                    )}
                  </View>
                  {!composerOpen &&
                    snapshot.listeningMode !== "auto" &&
                    (snapshot.manualHeld ||
                      captureCancelled ||
                      ["arming", "transcribing", "connecting"].includes(
                        snapshot.liveStatus,
                      )) && (
                      <Text
                        testID="manual-capture-status"
                        maxFontSizeMultiplier={1.6}
                        style={{ color: colors.muted, fontSize: 12 }}
                      >
                        {captureCancelled
                          ? tr("已取消", "Recording cancelled")
                          : snapshot.manualHeld
                            ? snapshot.liveStatus === "arming"
                              ? tr("正在准备麦克风…", "Preparing microphone…")
                              : tr(
                                  `松开发送 · 滑出取消 · ${recordingSeconds}s`,
                                  `Release to send · Slide to cancel · ${recordingSeconds}s`,
                                )
                            : snapshot.liveStatus === "transcribing"
                              ? tr("正在转写…", "Transcribing…")
                              : snapshot.liveStatus === "connecting"
                                ? tr("正在连接语音…", "Connecting voice…")
                                : snapshot.busy
                                  ? tr(
                                      "按住继续提问",
                                      "Hold to ask another question",
                                    )
                                  : tr("按住说话", "Hold to talk")}
                      </Text>
                    )}
                  {(!composerOpen || snapshot.listeningMode === "auto") && (
                    <View testID="question-toolbar" style={styles.voiceBar}>
                      {snapshot.listeningMode === "auto" ? (
                        <>
                          <View
                            style={{
                              flex: 1,
                              flexDirection: "row",
                              alignItems: "center",
                              gap: 8,
                            }}
                          >
                            <Ionicons
                              name={
                                snapshot.liveStatus === "on"
                                  ? "mic"
                                  : "mic-off-outline"
                              }
                              size={18}
                              color={colors.accent}
                            />
                            <Text
                              testID="voice-connection-status"
                              maxFontSizeMultiplier={1.6}
                              style={{
                                flex: 1,
                                color: colors.text,
                                fontSize: 13,
                              }}
                            >
                              {snapshot.liveStatus === "on"
                                ? tr(
                                    "正在聆听 · 直接开口就好",
                                    "Listening · just speak",
                                  )
                                : snapshot.liveStatus === "connecting"
                                  ? tr("正在连接…", "Connecting…")
                                  : tr("麦克风已关闭", "Microphone is off")}
                            </Text>
                            {snapshot.liveStatus === "on" && (
                              <View
                                testID="microphone-level"
                                accessibilityLabel={tr(
                                  "麦克风音量",
                                  "Microphone activity",
                                )}
                                style={{
                                  flexDirection: "row",
                                  height: 22,
                                  alignItems: "center",
                                  gap: 3,
                                }}
                              >
                                {[0.65, 1, 0.8, 0.5].map((scale, i) => (
                                  <View
                                    key={i}
                                    style={{
                                      width: 3,
                                      borderRadius: 2,
                                      height: Math.max(
                                        4,
                                        Math.min(22, inputLevel * 160 * scale),
                                      ),
                                      backgroundColor: colors.accent,
                                    }}
                                  />
                                ))}
                              </View>
                            )}
                          </View>
                          {button(
                            snapshot.liveStatus !== "off"
                              ? tr("关闭", "Stop")
                              : tr("开启", "Start"),
                            toggleConversation,
                            "toggle-conversation",
                            true,
                          )}
                        </>
                      ) : !composerOpen ? (
                        <View style={{ flex: 1 }}>
                          {button(
                            tr("开启随时聊", "Talk hands-free"),
                            toggleConversation,
                            "toggle-conversation",
                            false,
                            snapshot.manualHeld,
                          )}
                        </View>
                      ) : null}
                      {!composerOpen && (
                        <>
                          {snapshot.listeningMode !== "auto" && (
                            <Pressable
                              testID="hold-to-talk"
                              accessibilityRole="button"
                              accessibilityLabel={tr(
                                "按住说话",
                                "Hold to talk",
                              )}
                              pressRetentionOffset={{
                                top: 80,
                                bottom: 64,
                                left: 64,
                                right: 64,
                              }}
                              onPressIn={(event) => {
                                captureStart.current = {
                                  x: event.nativeEvent.pageX,
                                  y: event.nativeEvent.pageY,
                                };
                                setCaptureCancelled(false);
                                held.current = true;
                                const pv = ++pressVersion.current;
                                setError("");
                                void (async () => {
                                  if (!user) {
                                    setTab("account");
                                    return;
                                  }
                                  if (!(await microphonePermission())) {
                                    setError(
                                      tr(
                                        "允许麦克风后，再次按住开始录音",
                                        "After allowing microphone access, hold again to record",
                                      ),
                                    );
                                    return;
                                  }
                                  if (
                                    !held.current ||
                                    pv !== pressVersion.current
                                  )
                                    return;
                                  await session.beginManual();
                                })().catch(failure);
                              }}
                              onPressOut={() => {
                                const send = held.current;
                                held.current = false;
                                pressVersion.current++;
                                if (send) {
                                  session.endManual();
                                  followConversation.current = true;
                                  setPane("conversation");
                                  Keyboard.dismiss();
                                }
                                setCaptureCancelled(false);
                              }}
                              onTouchMove={(event) => {
                                const { pageX: x, pageY: y } =
                                  event.nativeEvent;
                                if (
                                  held.current &&
                                  (Math.abs(x - captureStart.current.x) > 64 ||
                                    Math.abs(y - captureStart.current.y) > 64)
                                ) {
                                  held.current = false;
                                  pressVersion.current++;
                                  setCaptureCancelled(true);
                                  session.cancelManualCapture();
                                }
                              }}
                              style={[
                                styles.holdControl,
                                {
                                  backgroundColor: snapshot.manualHeld
                                    ? "#943e3d"
                                    : colors.highlight,
                                },
                              ]}
                            >
                              <Ionicons
                                name={
                                  snapshot.manualHeld ? "radio" : "mic-outline"
                                }
                                size={19}
                                color={
                                  snapshot.manualHeld ? "#fff" : colors.accent
                                }
                              />
                              <Text
                                maxFontSizeMultiplier={1.5}
                                style={{
                                  color: snapshot.manualHeld
                                    ? "#fff"
                                    : colors.accent,
                                  fontWeight: "600",
                                  fontSize: 11,
                                }}
                              >
                                {tr("按住", "Hold")}
                              </Text>
                            </Pressable>
                          )}
                          {button(
                            tr("打字提问", "Type a question"),
                            () => setComposerOpen(true),
                            "question",
                            true,
                            snapshot.manualHeld,
                          )}
                        </>
                      )}
                    </View>
                  )}
                  {composerOpen && (
                    <View style={styles.composerRow}>
                      <TextInput
                        autoFocus
                        ref={questionInput}
                        maxFontSizeMultiplier={1.5}
                        testID="question"
                        accessibilityLabel="Question"
                        value={snapshot.question}
                        onChangeText={(text) => session.setQuestion(text)}
                        placeholder={tr(
                          "问问刚才的内容…",
                          "Ask about what you heard…",
                        )}
                        placeholderTextColor={colors.muted}
                        style={[
                          styles.input,
                          textStyle,
                          {
                            borderColor: colors.line,
                            backgroundColor: colors.background,
                            flex: 1,
                          },
                        ]}
                      />
                      {button(
                        tr("发送", "Send"),
                        () => {
                          if (!user) {
                            setTab("account");
                            return;
                          }
                          // Read the current draft; a keyboard event can precede React's render.
                          if (
                            session.submitQuestion(
                              session.getSnapshot().question,
                              session.getSnapshot().liveStatus === "on",
                            )
                          ) {
                            questionInput.current?.clear();
                            followConversation.current = true;
                            Keyboard.dismiss();
                            setPane("conversation");
                          }
                        },
                        "send-question",
                      )}
                      {button(
                        tr("收起文字输入", "Close text input"),
                        () => {
                          Keyboard.dismiss();
                          setComposerOpen(false);
                        },
                        "close-question",
                        true,
                      )}
                    </View>
                  )}
                </View>
              </>
            )}
          </>
        ) : (
          <>
            <FlatList
              testID="library"
              data={list}
              keyExtractor={(item) => item.id}
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingBottom: 20 }}
              ListHeaderComponent={
                <>
                  <View
                    style={[
                      styles.libraryHeading,
                      { backgroundColor: colors.navigation },
                    ]}
                  >
                    <Text
                      maxFontSizeMultiplier={1.35}
                      style={[styles.title, textStyle]}
                    >
                      {tr("音频库", "Library")}
                    </Text>
                    <Text
                      style={{
                        color: colors.muted,
                        fontSize: 14,
                        lineHeight: 22,
                      }}
                    >
                      {tr(
                        "从一段声音，开始一场对话。",
                        "Good listening starts a conversation.",
                      )}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.row,
                      {
                        justifyContent: "flex-start",
                        paddingHorizontal: 24,
                        paddingBottom: 16,
                        backgroundColor: colors.navigation,
                        borderBottomColor: colors.line,
                        borderBottomWidth: StyleSheet.hairlineWidth,
                      },
                    ]}
                  >
                    {button(
                      tr("我的音频", "My audio"),
                      () => {
                        if (!user) {
                          setTab("account");
                          return;
                        }
                        setCollection("private");
                        run(() => refreshPrivate());
                      },
                      "private-library",
                      collection !== "private",
                    )}
                    {button(
                      tr("公开示例", "Samples"),
                      () => setCollection("public"),
                      "public-library",
                      collection !== "public",
                    )}
                  </View>
                  {lastId
                    ? button(
                        tr("继续上次收听", "Continue listening"),
                        () => run(() => load(lastId)),
                        "continue-last",
                        true,
                      )
                    : null}
                  {loading ? <ActivityIndicator /> : null}
                  <View style={{ height: 20 }} />
                </>
              }
              ItemSeparatorComponent={() => <View style={{ height: 16 }} />}
              ListEmptyComponent={
                !loading ? (
                  <View
                    style={{
                      alignItems: "center",
                      paddingVertical: 42,
                      paddingHorizontal: 20,
                      gap: 16,
                    }}
                  >
                    <Ionicons
                      name="headset-outline"
                      size={36}
                      color={colors.accent}
                    />
                    <Text
                      maxFontSizeMultiplier={1.6}
                      style={[styles.subtitle, textStyle]}
                    >
                      {tr("音频库还是空的", "Your library is empty")}
                    </Text>
                    <Text
                      style={{
                        color: colors.muted,
                        textAlign: "center",
                        lineHeight: 23,
                      }}
                    >
                      {tr(
                        "上传一篇音频，让好奇的地方都有回应。",
                        "Bring an audio file. Leave room for questions.",
                      )}
                    </Text>
                    {button(
                      tr("添加音频", "Add audio"),
                      () => setTab("upload"),
                      "empty-upload",
                    )}
                  </View>
                ) : null
              }
              ListFooterComponent={
                collection === "private" && cursor
                  ? button(
                      tr("加载更多", "Load more"),
                      () => run(() => refreshPrivate(cursor)),
                      "load-more",
                      true,
                    )
                  : null
              }
              renderItem={({ item }) => (
                <Pressable
                  testID={`episode-${item.id}`}
                  accessibilityRole="button"
                  onPress={() => run(() => load(item.id))}
                  style={[
                    styles.card,
                    {
                      backgroundColor: colors.surface,
                      borderColor: colors.line,
                      marginHorizontal: 20,
                    },
                  ]}
                >
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 16,
                    }}
                  >
                    {item.cover ? (
                      <Image
                        source={{
                          uri: api.base + `/api/episodes/${item.id}/cover`,
                          headers: api.headers(),
                        }}
                        style={styles.artwork}
                      />
                    ) : (
                      <View
                        style={[
                          styles.artwork,
                          {
                            backgroundColor: colors.highlight,
                            justifyContent: "center",
                            alignItems: "center",
                          },
                        ]}
                      >
                        <Ionicons
                          name="musical-notes-outline"
                          size={28}
                          color={colors.accent}
                        />
                      </View>
                    )}
                    <View style={{ flex: 1, gap: 8 }}>
                      <Text
                        numberOfLines={2}
                        maxFontSizeMultiplier={1.6}
                        style={[styles.subtitle, textStyle]}
                      >
                        {item.title}
                      </Text>
                      <Text style={{ color: colors.muted, fontSize: 12 }}>
                        {item.status === "ready"
                          ? `${formatTime(item.durationMs)} · ${tr("音频", "Audio")}`
                          : item.stage}
                      </Text>
                    </View>
                    <Ionicons
                      name="arrow-forward"
                      size={19}
                      color={colors.accent}
                    />
                  </View>
                </Pressable>
              )}
            />
          </>
        )}
        {!keyboardVisible &&
        (!episode || tab !== "library") &&
        current.current ? (
          <View style={[styles.row, { backgroundColor: colors.surface }]}>
            <Text numberOfLines={1} style={[textStyle, { flex: 1 }]}>
              {current.current.title}
            </Text>
            {button(
              tr("打开播放器", "Open player"),
              () => {
                setEpisode(current.current);
                setTab("library");
              },
              "mini-player",
              true,
            )}
          </View>
        ) : null}
        <View
          style={[
            styles.tabs,
            {
              display:
                keyboardVisible || (episode && tab === "library")
                  ? "none"
                  : "flex",
            },
            { borderColor: colors.line, backgroundColor: colors.navigation },
          ]}
        >
          {(["library", "upload", "account"] as const).map((key, i) => (
            <Pressable
              key={key}
              testID={`tab-${key}`}
              accessibilityRole="tab"
              accessibilityLabel={
                [
                  tr("音频库", "Library"),
                  tr("上传", "Upload"),
                  tr("我的", "Account"),
                ][i]
              }
              accessibilityState={{ selected: tab === key }}
              onPress={() => setTab(key)}
              style={styles.tab}
            >
              <Ionicons
                name={
                  (
                    (tab === key
                      ? ["library", "add-circle", "person"]
                      : [
                          "library-outline",
                          "add-circle-outline",
                          "person-outline",
                        ]) as [
                      "library" | "library-outline",
                      "add-circle" | "add-circle-outline",
                      "person" | "person-outline",
                    ]
                  )[i]
                }
                size={22}
                color={tab === key ? colors.accent : colors.muted}
              />
              <Text
                maxFontSizeMultiplier={1.3}
                style={{
                  color: tab === key ? colors.accent : colors.muted,
                  fontWeight: "600",
                  fontSize: 11,
                }}
              >
                {
                  [
                    tr("音频库", "Library"),
                    tr("上传", "Upload"),
                    tr("我的", "Account"),
                  ][i]
                }
              </Text>
            </Pressable>
          ))}
        </View>
      </KeyboardAvoidingView>
      <Modal
        visible={playerOptions}
        transparent
        animationType="slide"
        onRequestClose={() => setPlayerOptions(false)}
      >
        <View
          style={{
            flex: 1,
            justifyContent: "flex-end",
            backgroundColor: "#00000055",
          }}
        >
          <Pressable
            style={{ flex: 1 }}
            accessibilityLabel={tr("关闭选项", "Close options")}
            onPress={() => setPlayerOptions(false)}
          />
          <View
            accessibilityViewIsModal
            style={{
              maxHeight: "90%",
              backgroundColor: colors.surface,
              borderTopLeftRadius: 24,
              borderTopRightRadius: 24,
              padding: 24,
              paddingBottom: 40,
              gap: 16,
            }}
          >
            <View
              style={[
                styles.row,
                { justifyContent: "space-between", padding: 0 },
              ]}
            >
              <Text
                maxFontSizeMultiplier={1.5}
                style={[styles.subtitle, textStyle, { flex: 1 }]}
              >
                {tr("播放与对话", "Playback & conversation")}
              </Text>
              {button(
                tr("完成", "Done"),
                () => setPlayerOptions(false),
                "close-player-options",
                true,
              )}
            </View>
            <ScrollView
              testID="player-options-content"
              style={{ flexShrink: 1 }}
              contentContainerStyle={{ gap: 16 }}
            >
              <View style={{ gap: 8 }}>
                <Text style={[textStyle, { fontWeight: "600" }]}>
                  {tr("回答后继续听", "Resume after answers")}
                </Text>
                <Text
                  style={{ color: colors.muted, fontSize: 13, lineHeight: 19 }}
                >
                  {tr(
                    "长回答至少等 8 秒，留一点追问的时间。",
                    "Long answers leave at least 8 seconds for a follow-up.",
                  )}
                </Text>
                <View
                  style={[
                    styles.row,
                    { justifyContent: "flex-start", paddingHorizontal: 0 },
                  ]}
                >
                  {[3000, 8000, 0].map((wait) => (
                    <React.Fragment key={wait}>
                      {button(
                        wait
                          ? tr(`${wait / 1000} 秒`, `${wait / 1000} seconds`)
                          : tr("手动", "Manual"),
                        () => {
                          session.setFollowupMs(wait);
                          void AsyncStorage.setItem(
                            "aside.followupMs",
                            String(wait),
                          ).catch(failure);
                        },
                        `followup-${wait}`,
                        snapshot.followupMs !== wait,
                      )}
                    </React.Fragment>
                  ))}
                </View>
              </View>
              {snapshot.listeningMode === "auto" &&
                button(
                  tr("切换为按住说话", "Switch to hold-to-talk"),
                  () => {
                    session.setListeningMode("manual");
                    setPlayerOptions(false);
                  },
                  "manual-mode",
                  true,
                )}
              {button(
                tr("开始新对话", "New conversation"),
                () => {
                  Alert.alert(
                    tr("开始新的对话？", "Start a new conversation?"),
                    tr(
                      "清空本篇的对话记录，保留收听位置。",
                      "Clear this episode’s conversation and keep your place.",
                    ),
                    [
                      { text: tr("取消", "Cancel"), style: "cancel" },
                      {
                        text: tr("新对话", "New conversation"),
                        onPress: () => {
                          setPlayerOptions(false);
                          void session.newConversation().catch(failure);
                        },
                      },
                    ],
                  );
                },
                "new-conversation",
                true,
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
      {Platform.OS === "ios" ? (
        <InputAccessoryView nativeID="verification-keyboard">
          <View
            style={{
              backgroundColor: colors.surface,
              alignItems: "flex-end",
              borderTopWidth: StyleSheet.hairlineWidth,
              borderColor: colors.line,
            }}
          >
            <Pressable
              testID="keyboard-done"
              accessibilityRole="button"
              onPress={Keyboard.dismiss}
              style={{
                minHeight: 44,
                minWidth: 64,
                paddingHorizontal: 20,
                justifyContent: "center",
              }}
            >
              <Text
                style={{
                  color: colors.accent,
                  fontSize: 17,
                  fontWeight: "600",
                }}
              >
                {tr("完成", "Done")}
              </Text>
            </Pressable>
          </View>
        </InputAccessoryView>
      ) : null}
    </SafeAreaView>
  );
}
export default function App() {
  return (
    <SafeAreaProvider>
      <Main />
    </SafeAreaProvider>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    paddingHorizontal: 24,
    paddingTop: 10,
    paddingBottom: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  compactHeader: {
    paddingBottom: 8,
    paddingTop: 4,
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
  },
  brand: {
    fontFamily: Platform.OS === "ios" ? "Georgia" : "serif",
    fontSize: 28,
    letterSpacing: -1,
  },
  content: { padding: 20, gap: 16 },
  title: {
    fontSize: 34,
    fontWeight: "700",
    lineHeight: 39,
    letterSpacing: -0.6,
  },
  subtitle: { fontSize: 16, lineHeight: 23, fontWeight: "600" },
  libraryHeading: {
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 18,
    gap: 8,
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  button: {
    flexShrink: 1,
    minHeight: 44,
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "transparent",
  },
  segment: {
    borderRadius: 8,
    paddingHorizontal: 17,
    minHeight: 44,
    paddingVertical: 9,
  },
  transport: {
    minWidth: 48,
    paddingHorizontal: 10,
    paddingVertical: 4,
    gap: 2,
  },
  playButton: {
    width: 58,
    height: 58,
    borderRadius: 29,
    paddingHorizontal: 0,
    marginHorizontal: 12,
  },
  sendButton: { width: 44, height: 44, paddingHorizontal: 0, borderRadius: 22 },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 15,
  },
  errorNotice: {
    position: "absolute",
    top: 8,
    left: 16,
    right: 16,
    margin: 0,
    marginHorizontal: 0,
    zIndex: 20,
    shadowColor: "#17251b",
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  notice: {
    marginHorizontal: 20,
    padding: 12,
    borderRadius: 12,
    gap: 8,
    flexDirection: "row",
    alignItems: "center",
    borderWidth: StyleSheet.hairlineWidth,
  },
  playerHeader: {
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  paneTabs: {
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  emptyConversation: {
    alignItems: "center",
    paddingVertical: 38,
    paddingHorizontal: 20,
    gap: 12,
  },
  artwork: { width: 64, height: 72, borderRadius: 10 },
  uploadArt: {
    width: 96,
    height: 96,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  card: {
    borderRadius: 18,
    padding: 18,
    marginBottom: 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  passage: { borderRadius: 10, padding: 14, gap: 8 },
  transcript: { fontSize: 17, lineHeight: 28 },
  bubble: { borderRadius: 16, padding: 14, gap: 6, marginBottom: 4 },
  voiceBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingTop: 8,
  },
  composerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingTop: 8,
  },
  holdControl: {
    width: 56,
    minHeight: 52,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  resumeBar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
    paddingTop: 4,
  },
  controls: {
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 4,
    shadowColor: "#102418",
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.05,
    shadowRadius: 12,
    elevation: 6,
  },
  timeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 8,
    marginTop: -5,
  },
  tabs: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth },
  tab: {
    flex: 1,
    paddingTop: 12,
    paddingBottom: 10,
    gap: 5,
    alignItems: "center",
    minHeight: 58,
  },
});
