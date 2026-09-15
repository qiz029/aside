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
const formatTime = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
function Main() {
  const dark = useColorScheme() === "dark";
  const colors = {
    background: dark ? "#1a1816" : "#f6f1e8",
    surface: dark ? "#282522" : "#fffbf4",
    text: dark ? "#efe9df" : "#2b2520",
    muted: dark ? "#bdb3a6" : "#6a5f55",
    accent: dark ? "#9cc0aa" : "#34503f",
    onAccent: dark ? "#1a281e" : "#ffffff",
    highlight: dark ? "#303d32" : "#e3e9df",
    line: dark ? "#3a3530" : "#e6ddcf",
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
    [error, setError] = useState(""),
    [email, setEmail] = useState(""),
    [code, setCode] = useState(""),
    [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false),
    [upload, setUpload] = useState<{
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
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
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
  const captureBounds = useRef({ width: 0, height: 0 });
  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        if (tab !== "library") {
          setTab("library");
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
  }, [tab, episode]);
  const lastUpload = useRef<AudioFile | null>(null);
  const current = useRef<Episode | null>(null),
    uploadAbort = useRef<AbortController | null>(null),
    generation = useRef(0),
    appState = useRef(AppState.currentState);
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
  async function refreshPrivate(next?: string) {
    if (!api.token) return;
    const page = await api.space(next);
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
      await api.restore();
      const savedLocale = await AsyncStorage.getItem("aside.locale");
      if (savedLocale) setLocale(savedLocale);
      setLastId(await AsyncStorage.getItem("aside.lastEpisode"));
      const account = await api.me().catch(async () => {
        await api.forget();
        return { user: null };
      });
      const [health, list] = await Promise.all([api.health(), api.list()]);
      if (disposed) return;
      session.configure(health);
      setEpisodes(list);
      setUser(account.user);
      if (account.user) {
        setCollection("private");
        await refreshPrivate();
      }
    })()
      .catch(failure)
      .finally(() => setLoading(false));
    let previousMode = session.getSnapshot().state.mode,
      previousHistory = session.getSnapshot().history;
    const unsubscribe = session.subscribe(() => {
      const next = session.getSnapshot();
      if (
        next.state.mode !== previousMode ||
        next.history !== previousHistory
      ) {
        previousMode = next.state.mode;
        previousHistory = next.history;
        void save().catch(failure);
      }
    });
    const nativeSubscription = audio.player.addListener(
      "playbackStatusUpdate",
      (status) => {
        if (!current.current) return;
        if (status.isLoaded) {
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
  useEffect(() => {
    if (followTranscript && passageIndex >= 0 && pane === "transcript")
      transcriptRef.current?.scrollToIndex({
        index: passageIndex,
        animated: true,
        viewPosition: 0.25,
      });
  }, [passageIndex, pane, followTranscript]);
  const initialSeek = useRef<string | null>(null);
  useEffect(() => {
    if (!episode) return;
    initialSeek.current = null;
    const sub = audio.player.addListener("playbackStatusUpdate", (status) => {
      if (status.isLoaded && initialSeek.current !== episode.id) {
        initialSeek.current = episode.id;
        session.metadataLoaded();
      }
    });
    return () => sub.remove();
  }, [episode?.id]);
  async function login() {
    setBusy(true);
    try {
      const next = await api.verify(email, code);
      setUser(next);
      setCollection("private");
      await refreshPrivate();
      if (current.current) {
        const cp = await sync.load(current.current.id);
        session.load(current.current, cp);
        session.metadataLoaded();
      }
      setTab("library");
    } finally {
      setBusy(false);
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
  const button = (
    label: string,
    action: () => void,
    testID?: string,
    secondary = false,
  ) => {
    const segmented = [
      "show-transcript",
      "show-conversation",
      "private-library",
      "public-library",
    ].includes(testID ?? "");
    const icon = (
      {
        "back-library": "chevron-back",
        "send-question": "arrow-up",
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
    ].includes(testID ?? "");
    const foreground =
      secondary || segmented || transport ? colors.text : colors.onAccent;
    return (
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={
          segmented
            ? { selected: !secondary }
            : {
                disabled:
                  testID === "send-question" &&
                  (!snapshot.question.trim() || snapshot.busy),
              }
        }
        disabled={
          testID === "send-question" &&
          (!snapshot.question.trim() || snapshot.busy)
        }
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
            opacity:
              testID === "send-question" &&
              (!snapshot.question.trim() || snapshot.busy)
                ? 0.35
                : pressed
                  ? 0.65
                  : 1,
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
  const microphoneDenied = rawError.includes("Microphone permission denied");
  const visibleError = microphoneDenied
    ? tr(
        "麦克风权限已关闭。请在设置中允许 Aside 使用麦克风。",
        "Microphone access is off. Allow Aside to use it in Settings.",
      )
    : rawError.includes("录音尚未准备好")
      ? tr(
          "麦克风还没准备好。请稍候，再按住录音。",
          "The microphone isn't ready yet. Wait a moment, then hold to record again.",
        )
      : rawError.includes("麦克风无法开始录音")
        ? tr(
            "麦克风暂时无法录音，请检查音频输入后重试。",
            "The microphone couldn't start. Check your audio input and try again.",
          )
        : locale === "en" && /[\u4e00-\u9fff]/.test(rawError)
          ? tr(
              "",
              "We couldn't complete that action. Please try again when you're ready.",
            )
          : rawError.replace(/^Error: /, "");
  const textStyle = { color: colors.text };
  const list = collection === "private" ? privateEpisodes : episodes;
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.background }]}>
      <StatusBar barStyle={dark ? "light-content" : "dark-content"} />
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        {!(episode && tab === "library") ? (
          <View style={styles.header}>
            <Text
              maxFontSizeMultiplier={1}
              style={[styles.brand, { color: colors.accent }]}
            >
              Aside.
            </Text>
          </View>
        ) : null}
        {error || snapshot.error ? (
          <View
            style={[
              styles.notice,
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
            ) : (
              <>
                <Text style={{ color: colors.muted }}>
                  {tr(
                    "登录后上传音频、提问，并在设备间接着听。",
                    "Sign in to upload, ask questions and continue across devices.",
                  )}
                </Text>
                <TextInput
                  maxFontSizeMultiplier={1.5}
                  testID="email"
                  autoComplete="email"
                  textContentType="emailAddress"
                  accessibilityLabel="Email"
                  autoCapitalize="none"
                  keyboardType="email-address"
                  value={email}
                  onChangeText={setEmail}
                  placeholder="Email"
                  placeholderTextColor={colors.muted}
                  style={[
                    styles.input,
                    textStyle,
                    { borderColor: colors.line },
                  ]}
                />
                {button(
                  tr("发送验证码", "Send code"),
                  () =>
                    run(async () => {
                      await api.startLogin(email);
                      setSent(true);
                    }),
                  "send-code",
                )}
                {sent ? (
                  <>
                    <TextInput
                      maxFontSizeMultiplier={1.5}
                      textContentType="oneTimeCode"
                      autoComplete="one-time-code"
                      testID="code"
                      accessibilityLabel="Verification code"
                      value={code}
                      onChangeText={(value) => {
                        const digits = value.replace(/\D/g, "").slice(0, 8);
                        setCode(digits);
                        if (digits.length === 8) Keyboard.dismiss();
                      }}
                      keyboardType="number-pad"
                      inputAccessoryViewID="verification-keyboard"
                      maxLength={8}
                      placeholder={tr("8 位验证码", "8-digit code")}
                      placeholderTextColor={colors.muted}
                      style={[
                        styles.input,
                        textStyle,
                        { borderColor: colors.line },
                      ]}
                    />
                    {busy ? (
                      <ActivityIndicator />
                    ) : (
                      button(tr("登录", "Sign in"), () => run(login), "sign-in")
                    )}
                  </>
                ) : null}
              </>
            )}
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
            <View style={styles.playerHeader}>
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
              <Text
                numberOfLines={2}
                maxFontSizeMultiplier={1.6}
                style={[styles.subtitle, textStyle, { flex: 1 }]}
              >
                {episode.title}
              </Text>
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
                <View style={styles.row}>
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
                    onContentSizeChange={() =>
                      chatRef.current?.scrollToEnd({ animated: true })
                    }
                    testID="conversation"
                    data={snapshot.history}
                    keyExtractor={(_, i) => String(i)}
                    contentContainerStyle={styles.content}
                    ListEmptyComponent={
                      <Text style={{ color: colors.muted }}>
                        {tr(
                          "对刚才听到的内容，有什么好奇？",
                          "What caught your curiosity?",
                        )}
                      </Text>
                    }
                    renderItem={({ item }) => (
                      <View
                        style={[
                          styles.bubble,
                          {
                            backgroundColor: colors.surface,
                            marginLeft: item.role === "user" ? 30 : 0,
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
                      style={{
                        color: colors.muted,
                        fontSize: 11,
                        fontVariant: ["tabular-nums"],
                      }}
                    >
                      {formatTime(snapshot.state.positionMs)}
                    </Text>
                    <Text
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
                  {snapshot.resumeSeconds !== null ? (
                    <Text style={{ color: colors.muted }}>
                      {tr(
                        `${snapshot.resumeSeconds} 秒后继续`,
                        `Resuming in ${snapshot.resumeSeconds}s`,
                      )}
                    </Text>
                  ) : null}
                  {snapshot.state.interruption ? (
                    <View style={styles.row}>
                      {button(
                        tr("继续听", "Continue"),
                        () => session.start(),
                        "resume",
                      )}
                      {button(
                        tr("先别继续", "Wait"),
                        () => session.holdResume(),
                        "hold",
                        true,
                      )}
                    </View>
                  ) : null}
                  <View style={styles.row}>
                    <TextInput
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
                        { borderColor: colors.line, flex: 1 },
                      ]}
                    />
                    {button(
                      tr("发送", "Send"),
                      () => {
                        if (!user) {
                          setTab("account");
                          return;
                        }
                        Keyboard.dismiss();
                        session.submitQuestion(snapshot.question);
                        setPane("conversation");
                      },
                      "send-question",
                    )}
                  </View>
                  <Pressable
                    testID="hold-to-talk"
                    accessibilityRole="button"
                    accessibilityLabel={tr("按住说话", "Hold to talk")}
                    onPressIn={() => {
                      held.current = true;
                      const pv = ++pressVersion.current;
                      run(async () => {
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
                        if (!held.current || pv !== pressVersion.current)
                          return;
                        setPane("conversation");
                        await session.beginManual();
                      });
                    }}
                    onPressOut={() => {
                      held.current = false;
                      pressVersion.current++;
                      session.endManual();
                    }}
                    onLayout={(event) => {
                      captureBounds.current = event.nativeEvent.layout;
                    }}
                    onTouchMove={(event) => {
                      const { locationX: x, locationY: y } = event.nativeEvent;
                      const { width, height } = captureBounds.current;
                      if (x < 0 || x > width || y < 0 || y > height) {
                        held.current = false;
                        pressVersion.current++;
                        session.cancelManualCapture();
                      }
                    }}
                    style={[
                      styles.button,
                      {
                        backgroundColor: snapshot.manualHeld
                          ? "#a73838"
                          : colors.highlight,
                        minHeight: 48,
                        flexDirection: "row",
                        gap: 8,
                      },
                    ]}
                  >
                    <Ionicons
                      name={snapshot.manualHeld ? "radio" : "mic-outline"}
                      size={19}
                      color={snapshot.manualHeld ? "#fff" : colors.accent}
                    />
                    <Text
                      style={{
                        color: snapshot.manualHeld ? "#fff" : colors.accent,
                        fontWeight: "600",
                        fontSize: 13,
                      }}
                    >
                      {snapshot.manualHeld
                        ? snapshot.liveStatus === "arming"
                          ? tr("正在准备麦克风…", "Preparing microphone…")
                          : tr(
                              `松开发送 · 滑出取消 · ${recordingSeconds}s`,
                              `Release to send · Slide to cancel · ${recordingSeconds}s`,
                            )
                        : snapshot.busy
                          ? tr("正在思考…", "Thinking…")
                          : tr("按住说话", "Hold to talk")}
                    </Text>
                  </Pressable>
                </View>
              </>
            )}
          </>
        ) : (
          <>
            <View style={styles.libraryHeading}>
              <Text
                maxFontSizeMultiplier={1.35}
                style={[styles.title, textStyle]}
              >
                {tr("音频库", "Library")}
              </Text>
              <Text
                style={{ color: colors.muted, fontSize: 14, lineHeight: 22 }}
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
                { justifyContent: "flex-start", paddingHorizontal: 24 },
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
            <FlatList
              testID="library"
              data={list}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.content}
              ListEmptyComponent={
                !loading ? (
                  <View
                    style={{
                      alignItems: "center",
                      paddingVertical: 42,
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
        {(!episode || tab !== "library") && current.current ? (
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
            { borderColor: colors.line, backgroundColor: colors.background },
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
                    [
                      "library-outline",
                      "add-circle-outline",
                      "person-outline",
                    ] as const
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
  header: { paddingHorizontal: 24, paddingTop: 14, paddingBottom: 22, gap: 6 },
  compactHeader: {
    paddingBottom: 8,
    paddingTop: 4,
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
  },
  brand: {
    fontFamily: Platform.OS === "ios" ? "Georgia" : "serif",
    fontSize: 30,
    letterSpacing: -1.3,
  },
  content: { padding: 24, gap: 18 },
  title: {
    fontSize: 34,
    fontWeight: "700",
    lineHeight: 39,
    letterSpacing: -0.6,
  },
  subtitle: { fontSize: 16, lineHeight: 23, fontWeight: "600" },
  libraryHeading: {
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 22,
    gap: 10,
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
    paddingVertical: 14,
  },
  artwork: { width: 68, height: 76, borderRadius: 8 },
  uploadArt: {
    width: 96,
    height: 96,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  card: {
    borderRadius: 14,
    padding: 16,
    marginBottom: 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  passage: { borderRadius: 10, padding: 14, gap: 8 },
  transcript: { fontSize: 17, lineHeight: 28 },
  bubble: { borderRadius: 14, padding: 16, gap: 8, marginBottom: 8 },
  controls: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 4,
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
