import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ActionSheetIOS,
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
  Share,
  StyleSheet,
  StatusBar,
  Text,
  TextInput,
  useColorScheme,
  useWindowDimensions,
  View,
} from "react-native";
import {
  SafeAreaProvider,
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import * as DocumentPicker from "expo-document-picker";
import Constants from "expo-constants";
import { File, Paths } from "expo-file-system";
import { AppleSignIn } from "./AppleSignIn";
import { PrivacyPanel, CONSENT_VERSION } from "./PrivacyPanel";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Scrubber } from "./Scrubber";
import { getLocales } from "expo-localization";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { groupByCollection, type Episode } from "@aside/engine/core";
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
  const insets = useSafeAreaInsets();
  const screen = useWindowDimensions();
  const pullX = useSharedValue(0);
  const pullY = useSharedValue(0);
  const playerMotion = useAnimatedStyle(() => ({
    transform: [{ translateX: pullX.value }, { translateY: pullY.value }],
    borderTopLeftRadius: Math.min(36, pullY.value / 3),
    borderTopRightRadius: Math.min(36, pullY.value / 3),
  }));
  // The website's palette (frontend/src/style.css). Amber marks live voice only.
  const colors = {
    background: dark ? "#1a1816" : "#f6f1e8",
    surface: dark ? "#24211e" : "#fffbf4",
    navigation: dark ? "#24211e" : "#fffbf4",
    text: dark ? "#ece5d8" : "#2b2520",
    muted: dark ? "#a89f92" : "#6b6157",
    accent: dark ? "#8fb8a2" : "#334d3d",
    onAccent: dark ? "#1a281e" : "#fffbf4",
    highlight: dark ? "#2a3b30" : "#e3e9df",
    line: dark ? "#38332d" : "#e6ddcf",
    fill: dark ? "#2e2a26" : "#efe9df",
    timestamp: dark ? "#8fb8a2" : "#4f7260",
    amber: "#d49a76",
    amberInk: dark ? "#efbf9b" : "#875944",
    amberSurface: dark ? "#3a2c22" : "#f4e8de",
  };
  const [locale, setLocale] = useState(
    getLocales()[0]?.languageCode === "zh" ? "zh" : "en",
  );
  const tr = (zh: string, en: string) => (locale === "zh" ? zh : en);
  // React Native has no font stacks; Georgia carries no Chinese glyphs.
  const serif = {
    fontFamily:
      Platform.OS === "ios"
        ? locale === "zh"
          ? "Songti SC"
          : "Georgia"
        : "serif",
    fontWeight: "400" as const,
  };
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
  const pendingAction = useRef<{
    kind: "upload" | "text" | "handsfree" | "manual" | "library";
    episodeId?: string;
    question?: string;
  } | null>(null);
  const [privacyVisible, setPrivacyVisible] = useState(false);
  const [consentBusy, setConsentBusy] = useState(false);
  const consentRequest = useRef<((allowed: boolean) => void) | null>(null);
  const consentApproved = useRef(false);
  const [profileEditing, setProfileEditing] = useState(false);
  const [profileAlias, setProfileAlias] = useState("");
  const [profileDescription, setProfileDescription] = useState("");
  const [accountBusy, setAccountBusy] = useState(false);

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
    consentApproved.current = false;
    consentRequest.current?.(false);
    consentRequest.current = null;
    setPrivacyVisible(false);
    pendingAction.current = null;
    uploadAbort.current?.abort();
    await api.cancelUpload();
    clearUploadFile();
    generation.current++;
    session.stop();
    audio.clear();
    current.current = null;
    setEpisode(null);
    setUser(null);
    setProfileEditing(false);
    setProfileAlias("");
    setProfileDescription("");
    setLastId(null);
    await AsyncStorage.removeItem("aside.lastEpisode");
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
          const pending = await api.pendingUpload();
          if (pending) {
            lastUpload.current = pending.file;
            void uploadFile(pending.file).catch(failure);
          }
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
        // iOS URLSession owns the transfer while JavaScript is suspended.
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
  function needLogin(
    kind: "upload" | "text" | "handsfree" | "manual" | "library",
  ) {
    pendingAction.current = {
      kind,
      episodeId: current.current?.id,
      question: session.getSnapshot().question,
    };
    setTab("account");
  }
  async function ensureConsent() {
    if (consentApproved.current) return true;
    const token = api.token;
    const status = await api.consent();
    if (!token || token !== api.token) return false;
    if (status.version !== CONSENT_VERSION)
      throw Error(
        tr(
          "请更新 App 后继续使用 AI 功能",
          "Update the app to review the latest AI notice",
        ),
      );
    if (status.accepted) {
      consentApproved.current = true;
      return true;
    }
    if (consentRequest.current) return false;
    setPrivacyVisible(true);
    return new Promise<boolean>((resolve) => {
      consentRequest.current = resolve;
    });
  }
  function closePrivacy(allowed = false) {
    setPrivacyVisible(false);
    consentRequest.current?.(allowed);
    consentRequest.current = null;
  }
  async function acceptPrivacy() {
    setConsentBusy(true);
    try {
      await api.acceptConsent(CONSENT_VERSION);
      consentApproved.current = true;
      closePrivacy(true);
    } catch (cause) {
      closePrivacy(false);
      failure(cause);
    } finally {
      setConsentBusy(false);
    }
  }
  async function submitText() {
    if (!api.token) {
      needLogin("text");
      return;
    }
    const id = current.current?.id;
    if (!(await ensureConsent()) || id !== current.current?.id) return;
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
  }
  async function startHandsfree() {
    const id = current.current?.id;
    if (!(await ensureConsent()) || id !== current.current?.id) return;
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
  }
  async function signedIn(next: User) {
    const intent = pendingAction.current;
    pendingAction.current = null;
    const local = session.checkpoint();
    setUser(next);
    setAccountState("ready");
    consentApproved.current = false;
    setCollection("private");
    setTab(intent?.kind === "upload" ? "upload" : "library");
    try {
      await refreshPrivate();
      if (current.current) {
        const cp = await sync.load(current.current.id);
        session.load(
          current.current,
          intent?.episodeId === current.current.id ? local : cp,
        );
        session.metadataLoaded();
        if (intent?.question) session.setQuestion(intent.question);
      }
      if (intent?.kind === "upload") await selectUpload();
      else if (intent?.episodeId === current.current?.id) {
        if (intent?.kind === "text") {
          setComposerOpen(true);
          await submitText();
        }
        if (intent?.kind === "handsfree") await startHandsfree();
        if (intent?.kind === "manual")
          setError(
            tr(
              "已登录，再次按住即可说话",
              "Signed in. Hold to talk when ready.",
            ),
          );
      }
    } catch (cause) {
      failure(cause);
    }
  }
  async function login(email: string, code: string) {
    setError("");
    await signedIn(await api.verify(email, code));
  }
  async function selectUpload() {
    if (!api.token) {
      needLogin("upload");
      return;
    }
    if (!(await ensureConsent())) return;
    const result = await DocumentPicker.getDocumentAsync({
      type: "audio/*",
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    const saved = new File(Paths.document, `aside-upload-${Date.now()}`);
    new File(asset.uri).copy(saved);
    const file: AudioFile = {
      uri: saved.uri,
      name: asset.name,
      mimeType: asset.mimeType ?? "application/octet-stream",
      size: asset.size ?? 0,
    };
    if (!file.size) {
      saved.delete();
      throw Error(tr("无法读取文件大小", "Cannot read file size"));
    }
    await api.cancelUpload();
    clearUploadFile();
    lastUpload.current = file;
    await uploadFile(file);
  }
  async function uploadFile(file: AudioFile) {
    if (uploadAbort.current || !(await ensureConsent())) return;
    if (uploadAbort.current) return;
    const revision = generation.current;
    const abort = new AbortController();
    uploadAbort.current = abort;
    setUpload({ name: file.name, progress: 0, phase: "uploading" });
    try {
      const next = await api.upload(file, abort.signal, (progress, phase) => {
        // Keep ownership until completion; cancellation also stops native tasks.
        setUpload({ name: file.name, progress, phase });
      });
      clearUploadFile();
      await refreshPrivate();
      if (revision !== generation.current) return;
      await load(next.id);
    } catch (error) {
      if (abort.signal.aborted) {
        clearUploadFile();
        throw new Error(
          tr(
            "上传已取消。可以重新选择音频。",
            "Upload cancelled. You can choose an audio file again.",
          ),
        );
      }
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
    if (!api.token) {
      needLogin("handsfree");
      return;
    }
    void startHandsfree().catch(failure);
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
    const paneTab = ["show-transcript", "show-conversation"].includes(
      testID ?? "",
    );
    const chip =
      ["private-library", "public-library"].includes(testID ?? "") ||
      !!testID?.startsWith("followup-");
    const segmented = paneTab || chip;
    const icon = (
      {
        "back-library": "chevron-down",
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
    const selectedChip = chip && !secondary;
    const pill = ["toggle-conversation", "resume", "hold"].includes(
      testID ?? "",
    );
    const foreground = selectedChip
      ? colors.onAccent
      : paneTab && secondary
        ? colors.muted
        : secondary || segmented || transport
          ? colors.text
          : colors.onAccent;
    const seekIcon =
      testID === "seek-back"
        ? "rewind-15"
        : testID === "seek-forward"
          ? "fast-forward-15"
          : null;
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
          paneTab && styles.segment,
          chip && styles.chip,
          pill && styles.pill,
          testID === "continue-last" && { marginHorizontal: 20, marginTop: 12 },
          transport && styles.transport,
          testID === "play-toggle" && styles.playButton,
          testID === "send-question" && styles.sendButton,
          {
            backgroundColor: paneTab
              ? !secondary
                ? colors.surface
                : "transparent"
              : chip
                ? selectedChip
                  ? colors.accent
                  : colors.fill
                : transport
                  ? "transparent"
                  : secondary
                    ? pill
                      ? colors.surface
                      : colors.fill
                    : colors.accent,
            opacity: disabled ? 0.35 : pressed ? 0.65 : 1,
            transform: [{ scale: pressed ? 0.97 : 1 }],
          },
          paneTab && !secondary && styles.raised,
        ]}
      >
        {seekIcon ? (
          <MaterialCommunityIcons
            name={seekIcon}
            size={32}
            color={foreground}
          />
        ) : icon ? (
          <Ionicons
            name={icon}
            size={testID === "play-toggle" ? 30 : 23}
            color={foreground}
          />
        ) : null}
        {!icon ? (
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
  // Playback continues behind the library; the mini player brings it back.
  const closePlayer = (axis: "x" | "y") => {
    (axis === "y" ? pullY : pullX).value = withTiming(
      axis === "y" ? screen.height : screen.width,
      { duration: 220 },
    );
    setTimeout(() => {
      setEpisode(null);
      pullX.value = 0;
      pullY.value = 0;
    }, 230);
  };
  const settle = { damping: 22, stiffness: 240 };
  const pullDown = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetY(12)
    .failOffsetX([-24, 24])
    .onUpdate((event) => {
      pullY.value = Math.max(0, event.translationY);
    })
    .onEnd((event) => {
      if (event.translationY > screen.height / 3 || event.velocityY > 900)
        closePlayer("y");
      else pullY.value = withSpring(0, settle);
    });
  const edgeBack = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetX(16)
    .failOffsetY([-20, 20])
    .onUpdate((event) => {
      pullX.value = Math.max(0, event.translationX);
    })
    .onEnd((event) => {
      if (event.translationX > screen.width / 3 || event.velocityX > 900)
        closePlayer("x");
      else pullX.value = withSpring(0, settle);
    });
  const paneSwipe = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetX([-28, 28])
    .failOffsetY([-14, 14])
    .onEnd((event) => {
      if (event.translationX < -60) setPane("conversation");
      else if (event.translationX > 60) setPane("transcript");
    });
  const passageMenu = (passage: { startMs: number; text: string }) => {
    const quote =
      passage.text.length > 24 ? `${passage.text.slice(0, 24)}…` : passage.text;
    const actions = [
      {
        label: tr("就这一段提问", "Ask about this passage"),
        run: () => {
          session.setQuestion(
            tr(`关于「${quote}」这一段：`, `About “${quote}”: `),
          );
          setComposerOpen(true);
        },
      },
      {
        label: tr("从这里播放", "Play from here"),
        run: () => {
          session.seek(passage.startMs);
          session.start();
        },
      },
      {
        label: tr("拷贝或分享文字", "Copy or share text"),
        run: () => void Share.share({ message: passage.text }).catch(failure),
      },
    ];
    if (Platform.OS === "ios")
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [...actions.map((a) => a.label), tr("取消", "Cancel")],
          cancelButtonIndex: actions.length,
        },
        (index) => actions[index]?.run(),
      );
    else
      Alert.alert(quote, undefined, [
        ...actions.map((a) => ({ text: a.label, onPress: a.run })),
        { text: tr("取消", "Cancel"), style: "cancel" as const },
      ]);
  };
  // Public samples are listed collection by collection, with a heading above
  // the first recording of each. A listener's own audio stays one flat list.
  const shelves = useMemo(() => {
    const groups = groupByCollection(episodes, locale);
    const titled = groups.some((group) => group.id);
    return {
      episodes: groups.flatMap((group) => group.episodes),
      // Keyed by episode: which shelf it is on, and the heading its first
      // recording carries. Loose recordings beside titled shelves get a
      // heading too, or they would read as part of the shelf above them.
      rows: new Map(
        groups.flatMap((group) =>
          group.episodes.map(
            (episode, index) =>
              [
                episode.id,
                {
                  shelf: group.id ?? "",
                  heading:
                    index === 0 && titled
                      ? (group.title ?? (locale === "zh" ? "其他" : "Other"))
                      : undefined,
                  count: group.episodes.length,
                },
              ] as const,
          ),
        ),
      ),
    };
  }, [episodes, locale]);
  const [foldedShelves, setFoldedShelves] = useState<Set<string>>(new Set());
  // A folded shelf keeps its first recording in the list, because that row
  // is what carries the heading; the row then draws the heading alone.
  const list =
    collection === "private"
      ? privateEpisodes
      : shelves.episodes.filter((item) => {
          const row = shelves.rows.get(item.id)!;
          return row.heading || !foldedShelves.has(row.shelf);
        });
  return (
    <SafeAreaView
      edges={["top", "left", "right"]}
      style={[styles.root, { backgroundColor: colors.background }]}
    >
      <StatusBar barStyle={dark ? "light-content" : "dark-content"} />
      <KeyboardAvoidingView
        style={[styles.root, { backgroundColor: colors.background }]}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        {!keyboardVisible && !(episode && tab === "library") ? (
          <View style={[styles.header, { backgroundColor: colors.background }]}>
            <Text
              maxFontSizeMultiplier={1}
              style={[styles.brand, { color: colors.accent }]}
            >
              Aside
            </Text>
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
              style={[styles.title, serif, textStyle]}
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
                <AppleSignIn
                  api={api}
                  locale={locale}
                  linking
                  onSignedIn={async (next) => {
                    setUser(next);
                  }}
                />
                {button(
                  tr("编辑资料", "Edit profile"),
                  () => {
                    setProfileAlias(user.alias);
                    setProfileDescription(user.description);
                    setProfileEditing(true);
                  },
                  "edit-profile",
                  true,
                  accountBusy,
                )}
                {profileEditing && (
                  <View style={{ gap: 12 }}>
                    <TextInput
                      accessibilityLabel={tr("昵称", "Display name")}
                      value={profileAlias}
                      onChangeText={setProfileAlias}
                      maxLength={40}
                      style={[styles.input, textStyle]}
                    />
                    <TextInput
                      accessibilityLabel={tr("简介", "Bio")}
                      value={profileDescription}
                      onChangeText={setProfileDescription}
                      maxLength={500}
                      multiline
                      style={[styles.input, textStyle]}
                    />
                    {button(
                      tr("保存资料", "Save profile"),
                      () =>
                        run(async () => {
                          setAccountBusy(true);
                          try {
                            setUser(
                              (
                                await api.updateProfile(
                                  profileAlias,
                                  profileDescription,
                                )
                              ).user,
                            );
                            setProfileEditing(false);
                          } finally {
                            setAccountBusy(false);
                          }
                        }),
                      "save-profile",
                      false,
                      accountBusy || !profileAlias.trim(),
                    )}
                  </View>
                )}
                {button(
                  tr("撤回 AI 授权", "Withdraw AI consent"),
                  () =>
                    Alert.alert(
                      tr("撤回 AI 授权？", "Withdraw AI consent?"),
                      tr(
                        "会停止当前对话和上传，之后仍可收听。已发送的数据无法收回。",
                        "Stops conversation and upload. Listening remains available. Data already sent cannot be recalled.",
                      ),
                      [
                        { text: tr("取消", "Cancel"), style: "cancel" },
                        {
                          text: tr("撤回", "Withdraw"),
                          onPress: () =>
                            run(async () => {
                              session.stop();
                              uploadAbort.current?.abort();
                              await api.cancelUpload();
                              consentApproved.current = false;
                              await api.revokeConsent();
                            }),
                        },
                      ],
                    ),
                  "withdraw-consent",
                  true,
                  accountBusy,
                )}
                {button(
                  tr("删除账号", "Delete account"),
                  () =>
                    Alert.alert(
                      tr("永久删除账号？", "Permanently delete account?"),
                      tr(
                        "你的音频、转录、收听进度和问答记录都会删除。登录立即失效，服务器随后清理数据；失败时会自动重试。此操作无法撤销。",
                        "Your audio, transcripts, progress and conversations will be deleted. Sign-in is revoked immediately; server cleanup follows and retries failures. This cannot be undone.",
                      ),
                      [
                        { text: tr("取消", "Cancel"), style: "cancel" },
                        {
                          text: tr("永久删除", "Delete permanently"),
                          style: "destructive",
                          onPress: () =>
                            run(async () => {
                              setAccountBusy(true);
                              try {
                                session.stop();
                                uploadAbort.current?.abort();
                                await api.cancelUpload();
                                await api.deleteAccount();
                                await clearAccount();
                                Alert.alert(
                                  tr("已提交删除", "Deletion requested"),
                                  tr(
                                    "账号已停用，正在清理数据。",
                                    "Your account is disabled and data cleanup is underway.",
                                  ),
                                );
                              } finally {
                                setAccountBusy(false);
                              }
                            }),
                        },
                      ],
                    ),
                  "delete-account",
                  true,
                  accountBusy,
                )}
                {button(
                  tr("退出登录", "Sign out"),
                  () =>
                    run(async () => {
                      await save().catch(() => {});
                      uploadAbort.current?.abort();
                      await api.cancelUpload();
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
              <>
                <AppleSignIn api={api} onSignedIn={signedIn} locale={locale} />
                <Text style={{ color: colors.muted }}>
                  {tr(
                    "已有账号？先用原邮箱登录，再绑定 Apple，保留已有内容。",
                    "Already have an account? Sign in with your original email, then link Apple to keep your library.",
                  )}
                </Text>
                <LoginForm
                  locale={locale}
                  colors={colors}
                  sendCode={(email) => api.startLogin(email)}
                  signIn={login}
                />
              </>
            )}
            {button(
              tr("隐私与 AI 数据处理", "Privacy and AI data processing"),
              () => setPrivacyVisible(true),
              "privacy",
              true,
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
              style={[styles.title, serif, textStyle]}
            >
              {tr("上传音频", "Upload audio")}
            </Text>
            <Text style={{ color: colors.muted }}>
              {tr(
                Platform.OS === "ios"
                  ? "单篇最长 5 小时、最大 1 GiB。支持后台上传；中断后可续传。"
                  : "单篇最长 5 小时、最大 1 GiB。中断后可从已保存的进度续传。",
                Platform.OS === "ios"
                  ? "Up to 5 hours and 1 GiB. Uploads continue in the background and can be resumed."
                  : "Up to 5 hours and 1 GiB. Interrupted uploads can resume saved progress.",
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
          <Animated.View
            style={[
              { flex: 1, overflow: "hidden" },
              { backgroundColor: colors.background },
              playerMotion,
            ]}
          >
            <GestureDetector gesture={pullDown}>
              <View>
                <View
                  style={[
                    styles.grabber,
                    { backgroundColor: dark ? "#5a5249" : "#c9bca9" },
                  ]}
                />
                <View style={styles.playerHeader}>
                  {button(
                    tr("返回音频库", "Library"),
                    () => {
                      setEpisode(null);
                    },
                    "back-library",
                    true,
                  )}
                  {episode.status === "ready" ? (
                    <View
                      style={[
                        styles.paneTabs,
                        { backgroundColor: colors.fill },
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
                  ) : (
                    <View style={{ flex: 1 }} />
                  )}
                  {button(
                    tr("播放与对话选项", "Playback and conversation options"),
                    () => setPlayerOptions(true),
                    "player-options",
                    true,
                  )}
                </View>
                {!keyboardVisible ? (
                  <Text
                    numberOfLines={2}
                    maxFontSizeMultiplier={1.4}
                    style={[styles.episodeTitle, serif, textStyle]}
                  >
                    {episode.title}
                  </Text>
                ) : null}
              </View>
            </GestureDetector>
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
                      () =>
                        run(async () => {
                          if (await ensureConsent())
                            await api.retry(episode.id);
                        }),
                      "retry-analysis",
                    )
                  : null}
              </View>
            ) : (
              <>
                <GestureDetector gesture={paneSwipe}>
                  <View style={{ flex: 1 }}>
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
                        contentContainerStyle={styles.reading}
                        renderItem={({ item }) => {
                          const current =
                            snapshot.state.positionMs >= item.startMs &&
                            snapshot.state.positionMs < item.endMs;
                          return (
                            <Pressable
                              onPress={() => {
                                session.seek(item.startMs);
                                session.start();
                              }}
                              onLongPress={() => passageMenu(item)}
                              delayLongPress={350}
                              style={[
                                styles.passage,
                                current && styles.raised,
                                {
                                  backgroundColor: current
                                    ? colors.surface
                                    : "transparent",
                                },
                              ]}
                            >
                              <Text
                                style={{
                                  color: colors.timestamp,
                                  fontSize: 12,
                                  fontVariant: ["tabular-nums"],
                                }}
                              >
                                {formatTime(item.startMs)}
                              </Text>
                              <Text
                                style={
                                  current
                                    ? [textStyle, styles.currentTranscript]
                                    : [
                                        styles.transcript,
                                        { color: colors.muted },
                                      ]
                                }
                              >
                                {item.text}
                              </Text>
                            </Pressable>
                          );
                        }}
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
                            <View testID="answer-stream" style={styles.answer}>
                              <View
                                style={{
                                  flexDirection: "row",
                                  alignItems: "center",
                                  gap: 8,
                                }}
                              >
                                <View style={styles.voiceMark}>
                                  {[6, 12, 8].map((height, i) => (
                                    <View
                                      key={i}
                                      style={{
                                        width: 3,
                                        height,
                                        borderRadius: 2,
                                        backgroundColor: colors.amber,
                                      }}
                                    />
                                  ))}
                                </View>
                                <Text
                                  style={[
                                    styles.eyebrow,
                                    { color: colors.amberInk },
                                  ]}
                                >
                                  Aside
                                </Text>
                                {!snapshot.answerPreview ? (
                                  <ActivityIndicator
                                    size="small"
                                    color={colors.amber}
                                  />
                                ) : null}
                              </View>
                              <Text
                                style={[
                                  styles.answerText,
                                  serif,
                                  {
                                    color: snapshot.answerPreview
                                      ? colors.text
                                      : colors.muted,
                                  },
                                ]}
                              >
                                {snapshot.answerPreview ||
                                  tr("正在想一想…", "Thinking it through…")}
                              </Text>
                            </View>
                          ) : null
                        }
                        renderItem={({ item }) =>
                          item.role === "user" ? (
                            <View
                              style={[
                                styles.bubble,
                                { backgroundColor: colors.highlight },
                              ]}
                            >
                              <Text
                                style={[
                                  styles.eyebrow,
                                  { color: colors.timestamp },
                                ]}
                              >
                                {tr("你", "You")}
                              </Text>
                              <Text style={[textStyle, styles.transcript]}>
                                {item.text}
                              </Text>
                            </View>
                          ) : (
                            <View style={styles.answer}>
                              <Text
                                style={[
                                  styles.eyebrow,
                                  { color: colors.muted },
                                ]}
                              >
                                Aside
                              </Text>
                              <Text
                                style={[styles.answerText, serif, textStyle]}
                              >
                                {item.text}
                              </Text>
                            </View>
                          )
                        }
                      />
                    )}
                  </View>
                </GestureDetector>
                <View
                  style={[
                    styles.controls,
                    {
                      borderColor: colors.line,
                      backgroundColor: colors.surface,
                      paddingBottom: keyboardVisible
                        ? 12
                        : Math.max(insets.bottom, 12),
                    },
                  ]}
                >
                  <View style={{ display: keyboardVisible ? "none" : "flex" }}>
                    <Scrubber
                      positionMs={snapshot.state.positionMs}
                      durationMs={episode.durationMs}
                      colors={colors}
                      label={tr("播放进度", "Playback position")}
                      fineLabel={(speed) =>
                        speed === 1
                          ? tr(
                              "手指上移，拖得更精细",
                              "Slide up for finer scrubbing",
                            )
                          : tr(
                              `${speed === 0.5 ? "半速" : "四分之一速"}精细拖动`,
                              `${speed === 0.5 ? "Half" : "Quarter"}-speed scrubbing`,
                            )
                      }
                      formatTime={formatTime}
                      onSeek={(value) => {
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
                    <View style={styles.transportRow}>
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
                      <View style={{ width: 48 }} />
                    </View>
                    {snapshot.state.interruption && (
                      <View
                        style={[
                          styles.resumeBar,
                          { backgroundColor: colors.amberSurface },
                        ]}
                      >
                        {snapshot.resumeSeconds !== null ? (
                          <View
                            style={[
                              styles.countdown,
                              { borderColor: colors.amber },
                            ]}
                          >
                            <Text
                              maxFontSizeMultiplier={1.2}
                              style={{
                                color: colors.amberInk,
                                fontSize: 13,
                                fontWeight: "700",
                                fontVariant: ["tabular-nums"],
                              }}
                            >
                              {snapshot.resumeSeconds}
                            </Text>
                          </View>
                        ) : null}
                        <Text
                          testID={
                            snapshot.resumeSeconds === null &&
                            (snapshot.resumeHeld ||
                              snapshot.resumeNeedsConfirmation)
                              ? "manual-resume-hint"
                              : undefined
                          }
                          maxFontSizeMultiplier={1.5}
                          style={{
                            color: colors.text,
                            fontSize: 14,
                            fontWeight: "600",
                            flexGrow: 1,
                            flexShrink: 1,
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
                        {!snapshot.resumeHeld &&
                          button(
                            tr("先别继续", "Wait"),
                            () => session.holdResume(),
                            "hold",
                            true,
                          )}
                        {button(
                          tr("继续听", "Continue"),
                          () => session.start(),
                          "resume",
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
                        <View
                          style={[
                            styles.listeningPill,
                            {
                              backgroundColor:
                                snapshot.liveStatus === "on"
                                  ? colors.highlight
                                  : colors.fill,
                            },
                          ]}
                        >
                          <View
                            style={[
                              styles.listeningDot,
                              {
                                // Amber while the microphone hears a voice.
                                backgroundColor:
                                  snapshot.liveStatus !== "on"
                                    ? colors.muted
                                    : inputLevel > 0.04
                                      ? colors.amber
                                      : colors.timestamp,
                              },
                            ]}
                          />
                          <Text
                            testID="voice-connection-status"
                            maxFontSizeMultiplier={1.6}
                            style={{
                              flex: 1,
                              color: colors.text,
                              fontSize: 14,
                              fontWeight: "600",
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
                                    backgroundColor:
                                      inputLevel > 0.04
                                        ? colors.amber
                                        : colors.timestamp,
                                  }}
                                />
                              ))}
                            </View>
                          )}
                          {button(
                            snapshot.liveStatus !== "off"
                              ? tr("关闭", "Stop")
                              : tr("开启", "Start"),
                            toggleConversation,
                            "toggle-conversation",
                            true,
                          )}
                        </View>
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
                                    needLogin("manual");
                                    return;
                                  }
                                  if (!(await ensureConsent())) return;
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
                                    ? "#a53831"
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
                        () => run(submitText),
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
            <GestureDetector gesture={edgeBack}>
              <View style={styles.backEdge} />
            </GestureDetector>
          </Animated.View>
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
                  <View style={styles.libraryHeading}>
                    <Text
                      maxFontSizeMultiplier={1.35}
                      style={[styles.title, serif, textStyle]}
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
                        paddingHorizontal: 20,
                        paddingTop: 0,
                        paddingBottom: 8,
                        gap: 8,
                      },
                    ]}
                  >
                    {button(
                      tr("我的音频", "My audio"),
                      () => {
                        if (!user) {
                          needLogin("library");
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
              ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
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
              renderItem={({ item }) => {
                const row =
                  collection === "public"
                    ? shelves.rows.get(item.id)
                    : undefined;
                const folded = !!row && foldedShelves.has(row.shelf);
                return (
                  <>
                    {row?.heading ? (
                      <Pressable
                        testID={`shelf-${row.shelf}`}
                        accessibilityRole="button"
                        accessibilityState={{ expanded: !folded }}
                        onPress={() =>
                          setFoldedShelves((old) => {
                            const next = new Set(old);
                            if (!next.delete(row.shelf)) next.add(row.shelf);
                            return next;
                          })
                        }
                        style={styles.shelfHeading}
                      >
                        <Ionicons
                          name={folded ? "chevron-forward" : "chevron-down"}
                          size={14}
                          color={colors.muted}
                        />
                        <Text
                          maxFontSizeMultiplier={1.6}
                          style={[styles.shelfTitle, { color: colors.muted }]}
                        >
                          {row.heading}
                        </Text>
                        <Text style={{ color: colors.muted, fontSize: 12 }}>
                          {row.count}
                        </Text>
                      </Pressable>
                    ) : null}
                    {folded ? null : (
                      <Pressable
                        testID={`episode-${item.id}`}
                        accessibilityRole="button"
                        onPress={() => run(() => load(item.id))}
                        style={[
                          styles.card,
                          styles.raised,
                          {
                            backgroundColor: colors.surface,
                            marginHorizontal: 20,
                          },
                        ]}
                      >
                        <View
                          style={{
                            flexDirection: "row",
                            alignItems: "center",
                            gap: 14,
                          }}
                        >
                          {item.cover ? (
                            <Image
                              source={{
                                uri:
                                  api.base + `/api/episodes/${item.id}/cover`,
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
                                size={24}
                                color={colors.accent}
                              />
                            </View>
                          )}
                          <View style={{ flex: 1, gap: 4 }}>
                            <Text
                              numberOfLines={2}
                              maxFontSizeMultiplier={1.6}
                              style={[styles.cardTitle, serif, textStyle]}
                            >
                              {item.title}
                            </Text>
                            <Text style={{ color: colors.muted, fontSize: 13 }}>
                              {item.status === "ready"
                                ? `${formatTime(item.durationMs)} · ${tr("音频", "Audio")}`
                                : item.stage}
                            </Text>
                          </View>
                        </View>
                      </Pressable>
                    )}
                  </>
                );
              }}
            />
          </>
        )}
        {!keyboardVisible &&
        (!episode || tab !== "library") &&
        current.current ? (
          <Pressable
            testID="mini-player"
            accessibilityRole="button"
            accessibilityLabel={tr("打开播放器", "Open player")}
            onPress={() => {
              setEpisode(current.current);
              setTab("library");
            }}
            style={({ pressed }) => [
              styles.miniPlayer,
              {
                backgroundColor: dark ? colors.highlight : colors.accent,
                opacity: pressed ? 0.85 : 1,
              },
            ]}
          >
            <View style={[styles.voiceMark, { height: 18 }]}>
              {[8, 18, 12].map((height, i) => (
                <View
                  key={i}
                  style={{
                    width: 3,
                    height: snapshot.state.mode === "playing" ? height : 5,
                    borderRadius: 2,
                    backgroundColor: "#efbf9b",
                  }}
                />
              ))}
            </View>
            <View style={{ flex: 1, gap: 1 }}>
              <Text
                numberOfLines={1}
                maxFontSizeMultiplier={1.4}
                style={{
                  color: dark ? colors.text : colors.onAccent,
                  fontSize: 15,
                }}
              >
                {current.current.title}
              </Text>
              <Text
                numberOfLines={1}
                maxFontSizeMultiplier={1.4}
                style={{ color: "#b9d3bf", fontSize: 12 }}
              >
                {snapshot.liveStatus === "on"
                  ? tr("聆听中 · 直接开口提问", "Listening · just speak")
                  : snapshot.state.mode === "playing"
                    ? tr("正在播放", "Playing")
                    : tr("已暂停", "Paused")}
              </Text>
            </View>
            <Ionicons
              name="chevron-up"
              size={20}
              color={dark ? colors.text : colors.onAccent}
            />
          </Pressable>
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
            {
              borderColor: colors.line,
              backgroundColor: colors.navigation,
              paddingBottom: insets.bottom,
            },
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
            backgroundColor: "#2b252080",
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
              backgroundColor: colors.background,
              borderTopLeftRadius: 28,
              borderTopRightRadius: 28,
              paddingHorizontal: 20,
              paddingTop: 10,
              paddingBottom: Math.max(insets.bottom, 16) + 16,
              gap: 16,
            }}
          >
            <View
              style={{
                alignSelf: "center",
                width: 36,
                height: 5,
                borderRadius: 3,
                backgroundColor: dark ? "#5a5249" : "#c9bca9",
              }}
            />
            <View
              style={[
                styles.row,
                { justifyContent: "space-between", padding: 0 },
              ]}
            >
              <Text
                maxFontSizeMultiplier={1.5}
                style={[styles.sheetTitle, serif, textStyle, { flex: 1 }]}
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
              <View
                style={[styles.sheetGroup, { backgroundColor: colors.surface }]}
              >
                <Text style={[textStyle, { fontSize: 16, fontWeight: "600" }]}>
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
      <PrivacyPanel
        visible={privacyVisible}
        consent={!!consentRequest.current}
        locale={locale}
        dark={dark}
        busy={consentBusy}
        close={() => closePrivacy()}
        accept={() => {
          void acceptPrivacy();
        }}
      />
    </SafeAreaView>
  );
}
export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <Main />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    paddingHorizontal: 20,
    paddingTop: 6,
    paddingBottom: 6,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
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
    fontStyle: "italic",
    fontSize: 21,
  },
  content: { padding: 20, gap: 16 },
  title: { fontSize: 34, lineHeight: 42, letterSpacing: 0.5 },
  subtitle: { fontSize: 16, lineHeight: 23, fontWeight: "600" },
  libraryHeading: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 16,
    gap: 6,
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
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  segment: {
    borderRadius: 16,
    paddingHorizontal: 16,
    minHeight: 34,
    paddingVertical: 6,
  },
  chip: {
    borderRadius: 18,
    paddingHorizontal: 16,
    minHeight: 36,
    paddingVertical: 7,
  },
  pill: { borderRadius: 22, paddingHorizontal: 16 },
  raised: {
    shadowColor: "#2b2520",
    shadowOpacity: 0.1,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  transport: {
    minWidth: 48,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  transportRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 6,
    paddingBottom: 4,
  },
  playButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    paddingHorizontal: 0,
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
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  paneTabs: { flexDirection: "row", borderRadius: 19, padding: 3, gap: 2 },
  episodeTitle: {
    fontSize: 23,
    lineHeight: 31,
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 12,
  },
  emptyConversation: {
    alignItems: "center",
    paddingVertical: 38,
    paddingHorizontal: 20,
    gap: 12,
  },
  artwork: { width: 56, height: 56, borderRadius: 14 },
  uploadArt: {
    width: 96,
    height: 96,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  card: { borderRadius: 20, padding: 14 },
  passage: {
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 4,
  },
  reading: { paddingHorizontal: 12, paddingVertical: 8, gap: 4 },
  currentTranscript: { fontSize: 19, lineHeight: 31 },
  transcript: { fontSize: 17, lineHeight: 28 },
  bubble: {
    alignSelf: "flex-end",
    maxWidth: "86%",
    borderRadius: 20,
    borderBottomRightRadius: 6,
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 4,
  },
  answer: { gap: 8, paddingRight: 12, paddingVertical: 4 },
  answerText: { fontSize: 19, lineHeight: 32 },
  eyebrow: { fontSize: 11, fontWeight: "700", letterSpacing: 1.2 },
  voiceMark: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 2,
    height: 12,
  },
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
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    gap: 1,
  },
  listeningPill: {
    flex: 1,
    minHeight: 52,
    borderRadius: 26,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingLeft: 18,
    paddingRight: 4,
    paddingVertical: 4,
  },
  listeningDot: { width: 10, height: 10, borderRadius: 5 },
  resumeBar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
    marginTop: 6,
    borderRadius: 18,
    paddingLeft: 14,
    paddingRight: 8,
    paddingVertical: 8,
  },
  countdown: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 3,
    alignItems: "center",
    justifyContent: "center",
  },
  controls: {
    paddingHorizontal: 20,
    paddingTop: 12,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    gap: 4,
    shadowColor: "#2b2520",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.08,
    shadowRadius: 14,
    elevation: 6,
  },
  timeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: -6,
  },
  tabs: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth },
  cardTitle: { fontSize: 17, lineHeight: 24 },
  shelfHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 44,
    marginHorizontal: 24,
    marginTop: 6,
  },
  shelfTitle: { flex: 1, fontSize: 13, fontWeight: "600", letterSpacing: 0.3 },
  grabber: {
    alignSelf: "center",
    width: 36,
    height: 5,
    borderRadius: 3,
    marginTop: 4,
  },
  backEdge: { position: "absolute", left: 0, top: 110, bottom: 280, width: 22 },
  sheetTitle: { fontSize: 25, lineHeight: 32 },
  sheetGroup: { borderRadius: 18, padding: 16, gap: 8 },
  miniPlayer: {
    marginHorizontal: 12,
    marginBottom: 8,
    borderRadius: 18,
    minHeight: 56,
    paddingLeft: 16,
    paddingRight: 14,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    shadowColor: "#2b2520",
    shadowOpacity: 0.3,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
  tab: {
    flex: 1,
    paddingTop: 12,
    paddingBottom: 10,
    gap: 5,
    alignItems: "center",
    minHeight: 58,
  },
});
