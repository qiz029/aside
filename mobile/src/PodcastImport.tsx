import React, { useEffect, useRef, useState } from "react";
import {
  AppState,
  NativeModules,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
interface Entry {
  id: string;
  url: string;
}
export function usePodcastImport({
  ready,
  importEpisode,
}: {
  ready: boolean;
  importEpisode(url: string): Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const [entry, setEntry] = useState<Entry>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const attempted = useRef("");
  const latest = useRef(importEpisode);
  latest.current = importEpisode;
  const inbox = NativeModules.AsidePodcastInbox as
    { list(): Promise<Entry[]>; remove(id: string): Promise<void> } | undefined;
  useEffect(() => {
    let active = true;
    const read = () =>
      void inbox
        ?.list()
        .then((items) => {
          if (active && items[0]) {
            setEntry(items[0]);
            setUrl(items[0].url);
          }
        })
        .catch(() => {});
    read();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") read();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  async function submit(value: string, saved?: Entry) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await latest.current(value.trim());
      if (saved) await inbox?.remove(saved.id);
      setEntry(undefined);
      setUrl("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    if (ready && !busy && entry && attempted.current !== entry.id) {
      attempted.current = entry.id;
      void submit(entry.url, entry);
    }
  }, [ready, busy, entry?.id]);
  return {
    url,
    setUrl: (value: string) => {
      setUrl(value);
      setEntry(undefined);
    },
    busy,
    error,
    submit: () => submit(url, entry),
  };
}
export function PodcastImport({
  controller,
  tr,
  colors,
}: {
  controller: ReturnType<typeof usePodcastImport>;
  tr(zh: string, en: string): string;
  colors: { text: string; muted: string; accent: string; fill: string };
}) {
  const { url, setUrl, busy, error, submit } = controller;
  return (
    <View
      style={{
        marginHorizontal: 20,
        marginBottom: 16,
        padding: 16,
        borderRadius: 16,
        backgroundColor: colors.fill,
        gap: 10,
      }}
    >
      <Text style={{ color: colors.text, fontWeight: "600" }}>
        {tr("粘贴链接，直接收听", "Paste a link and listen")}
      </Text>
      <Text style={{ color: colors.muted }}>
        {tr(
          "支持 Apple Podcasts 单集链接，也可以从系统分享菜单选择 Aside。",
          "Use an Apple Podcasts episode link, or choose Aside from the share menu.",
        )}
      </Text>
      <TextInput
        testID="podcast-link"
        accessibilityLabel={tr("播客单集链接", "Podcast episode link")}
        value={url}
        onChangeText={(value) => {
          setUrl(value);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={tr("粘贴单集分享链接", "Paste an episode link")}
        placeholderTextColor={colors.muted}
        style={{ color: colors.text, paddingVertical: 8 }}
      />
      <Pressable
        testID="import-podcast"
        accessibilityRole="button"
        disabled={busy || !url.trim()}
        onPress={() => void submit()}
      >
        <Text
          style={{
            color: colors.accent,
            opacity: busy || !url.trim() ? 0.5 : 1,
          }}
        >
          {busy
            ? tr("正在打开播客…", "Opening podcast…")
            : tr("直接收听", "Listen now")}
        </Text>
      </Pressable>
      {!!error && (
        <Text accessibilityRole="alert" style={{ color: colors.accent }}>
          {error}
        </Text>
      )}
    </View>
  );
}
