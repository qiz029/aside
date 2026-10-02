import React, { useEffect, useState, useSyncExternalStore } from "react";
import { View, Text, TextInput, Pressable, Image } from "react-native";
import { PodcastDiscovery as Controller } from "@aside/player-runtime/podcast-discovery";
import type { PodcastDirectory } from "@aside/player-runtime/podcast-discovery";
import type {
  PodcastShow,
  PodcastEpisode,
  PodcastSelection,
} from "@aside/engine/contracts";
export function PodcastDiscovery({
  api,
  signedIn,
  onLogin,
  onPlay,
  tr,
  colors,
}: {
  api: PodcastDirectory;
  signedIn: boolean;
  onLogin(): void;
  onPlay(selection: PodcastSelection): Promise<void>;
  tr(zh: string, en: string): string;
  colors: { text: string; muted: string; accent: string; fill: string };
}) {
  const [controller] = useState(() => new Controller(api));
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [query, setQuery] = useState(""),
    [country, setCountry] = useState(tr("CN", "US"));
  const [opening, setOpening] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (signedIn) void controller.refresh();
    return () => controller.dispose();
  }, [controller, signedIn]);
  const button = (label: string, action: () => void, disabled = false) => (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={action}
      style={{
        paddingVertical: 12,
        paddingHorizontal: 14,
        borderRadius: 12,
        backgroundColor: colors.fill,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text style={{ color: colors.accent, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
  async function play(show: PodcastShow, item: PodcastEpisode) {
    if (!signedIn) {
      onLogin();
      return;
    }
    if (opening) return;
    setOpening(true);
    setError("");
    try {
      await onPlay({ showId: show.id, country: show.country, guid: item.guid });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(false);
    }
  }
  const episode = (show: PodcastShow, item: PodcastEpisode) => (
    <View
      key={`${show.id}:${item.guid}`}
      style={{ paddingVertical: 14, gap: 8 }}
    >
      <Text style={{ color: colors.text, fontWeight: "600", fontSize: 16 }}>
        {item.title}
      </Text>
      <Text style={{ color: colors.muted }}>
        {show.title}
        {item.publishedAt
          ? ` · ${new Date(item.publishedAt).toLocaleDateString()}`
          : ""}
        {item.durationMs ? ` · ${Math.round(item.durationMs / 60000)} min` : ""}
      </Text>
      {state.show && !!item.description && (
        <Text numberOfLines={3} style={{ color: colors.muted }}>
          {item.description}
        </Text>
      )}
      {button(
        opening ? tr("正在打开…", "Opening…") : tr("收听", "Listen"),
        () => void play(show, item),
        opening,
      )}
    </View>
  );
  return (
    <View style={{ padding: 20, gap: 12 }}>
      <Text style={{ color: colors.text, fontSize: 24, fontWeight: "700" }}>
        {tr("搜索播客", "Search podcasts")}
      </Text>
      <TextInput
        testID="podcast-search"
        accessibilityLabel={tr("节目名或关键词", "Show name or keyword")}
        value={query}
        onChangeText={setQuery}
        placeholder={tr("节目名或关键词", "Show name or keyword")}
        placeholderTextColor={colors.muted}
        maxLength={120}
        returnKeyType="search"
        onSubmitEditing={() => {
          if (query.trim().length >= 2) void controller.search(query, country);
        }}
        style={{
          color: colors.text,
          backgroundColor: colors.fill,
          padding: 14,
          borderRadius: 12,
        }}
      />
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        {["CN", "US", "GB", "TW", "HK"].map((value) => (
          <Pressable
            key={value}
            accessibilityRole="radio"
            accessibilityState={{ checked: country === value }}
            onPress={() => setCountry(value)}
            style={{
              padding: 10,
              backgroundColor: country === value ? colors.fill : undefined,
              borderRadius: 10,
            }}
          >
            <Text
              style={{
                color: country === value ? colors.accent : colors.muted,
              }}
            >
              {value}
            </Text>
          </Pressable>
        ))}
      </View>
      {button(
        tr("搜索", "Search"),
        () => void controller.search(query, country),
        state.busy || query.trim().length < 2,
      )}
      {(error || state.error) && (
        <Text accessibilityRole="alert" style={{ color: colors.accent }}>
          {error || state.error}
        </Text>
      )}
      {state.busy && (
        <Text style={{ color: colors.muted }}>
          {tr("正在加载…", "Loading…")}
        </Text>
      )}
      {state.show ? (
        <>
          {button(tr("返回", "Back"), () => controller.back())}
          <Text style={{ color: colors.text, fontSize: 22, fontWeight: "700" }}>
            {state.show.show.title}
          </Text>
          <Text style={{ color: colors.muted }}>{state.show.show.author}</Text>
          {button(
            state.subscriptions.subscriptions.some(
              (s) => s.show.id === state.show!.show.id,
            )
              ? tr("取消订阅", "Unsubscribe")
              : tr("订阅", "Subscribe"),
            () => {
              if (!signedIn) onLogin();
              else void controller.toggle(state.show!.show);
            },
            state.busy,
          )}
          {state.show.stale && (
            <Text style={{ color: colors.muted }}>
              {tr(
                "暂时无法更新，显示上次保存的单集。",
                "Showing saved episodes; updates are temporarily unavailable.",
              )}
            </Text>
          )}
          {state.show.episodes.map((item) => episode(state.show!.show, item))}
          {!state.show.episodes.length && (
            <Text style={{ color: colors.muted }}>
              {tr("暂无公开单集", "No public episodes available")}
            </Text>
          )}
        </>
      ) : (
        <>
          {state.searched && !state.busy && !state.results.length && (
            <Text style={{ color: colors.muted }}>
              {tr(
                "没有找到节目，试试其他关键词或地区。",
                "No shows found. Try another keyword or region.",
              )}
            </Text>
          )}
          {state.results.map((show) => (
            <Pressable
              key={show.id}
              accessibilityRole="button"
              onPress={() => void controller.open(show)}
              style={{
                flexDirection: "row",
                gap: 12,
                paddingVertical: 12,
                alignItems: "center",
              }}
            >
              {show.artworkUrl && (
                <Image
                  source={{ uri: show.artworkUrl }}
                  style={{ width: 56, height: 56, borderRadius: 12 }}
                />
              )}
              <View style={{ flex: 1 }}>
                <Text
                  style={{
                    color: colors.text,
                    fontSize: 17,
                    fontWeight: "600",
                  }}
                >
                  {show.title}
                </Text>
                <Text style={{ color: colors.muted }}>{show.author}</Text>
              </View>
            </Pressable>
          ))}
          <Text
            style={{
              color: colors.text,
              fontSize: 22,
              fontWeight: "700",
              marginTop: 16,
            }}
          >
            {tr("我的订阅", "My subscriptions")}
          </Text>
          {signedIn ? (
            <>
              {button(
                tr("刷新列表", "Refresh list"),
                () => void controller.refresh(),
                state.busy,
              )}
              {state.subscriptions.subscriptions.map(({ show, stale }) => (
                <View key={show.id}>
                  {button(
                    show.title + (stale ? " · ↻" : ""),
                    () => void controller.open(show),
                  )}
                </View>
              ))}
              {!state.subscriptions.subscriptions.length && (
                <Text style={{ color: colors.muted }}>
                  {tr(
                    "订阅喜欢的节目，新单集会自动出现在这里。",
                    "Subscribe to a show to see its latest episodes here.",
                  )}
                </Text>
              )}
              {state.subscriptions.episodes.map(({ show, episode: item }) =>
                episode(show, item),
              )}
            </>
          ) : (
            button(
              tr("登录后订阅和收听", "Sign in to subscribe and listen"),
              onLogin,
            )
          )}
        </>
      )}
    </View>
  );
}
