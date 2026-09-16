import { LibraryDrawer } from "./LibraryDrawer";
import { audioCard, episodeHref, libraryFor } from "./library-item";
import { Landing } from "./Landing";
import { AccountControl } from "./AccountControl";
import { Space } from "./Space";
import { PlayerView } from "./PlayerView";
import { homeHref, t, useLocale, message } from "./i18n";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { usePlayerController } from "./usePlayerController";
import "./style.css";
import "./components.css";
const debugRequested = new URLSearchParams(location.search).has("debug");
const debugHref = (href: string) =>
  debugRequested ? `${href}${href.includes("?") ? "&" : "?"}debug` : href;
function App() {
  const locale = useLocale();
  const player = usePlayerController();
  const {
    episodes,
    episodesLoading,
    episode,
    error,
    setError,
    load,
    enter,
    playEpisode,
    authChanged,
  } = player;
  const [accountUser, setAccountUser] = useState<{ id: string } | null>(null);
  const [accountVersion, setAccountVersion] = useState(0);
  useEffect(() => {
    if (episode) window.scrollTo(0, 0);
  }, [episode?.id]);
  useEffect(() => {
    void fetch("/api/auth/session")
      .then((response) => response.json())
      .then((data: { user: { id: string } | null }) =>
        setAccountUser(data.user),
      )
      .catch(() => {});
    // /episodes/<id> is the indexable address; ?episode=<id> is the older
    // share link and still resolves to it.
    const fromPath = /^\/episodes\/([a-zA-Z0-9-]+)\/?$/.exec(
      location.pathname,
    )?.[1];
    const fromQuery = new URLSearchParams(location.search).get("episode");
    const selected =
      fromPath ??
      (fromQuery && /^[a-zA-Z0-9-]+$/.test(fromQuery) ? fromQuery : undefined);
    if (selected) {
      if (location.pathname !== "/space")
        window.history.replaceState(null, "", debugHref(episodeHref(selected)));
      void load(selected).catch((cause) => setError(cause.message));
    }
  }, []);
  async function accountUpdated() {
    await authChanged();
    const response = await fetch("/api/auth/session");
    const data = (await response.json()) as { user: { id: string } | null };
    setAccountUser(data.user);
    setAccountVersion((version) => version + 1);
  }
  if (location.pathname === "/space")
    return (
      <Space
        publicHref={episodes[0] ? episodeHref(episodes[0].id) : homeHref()}
        accountControl={<AccountControl onAuthChanged={accountUpdated} />}
        accountVersion={accountVersion}
        activeEpisodeId={episode?.id}
        player={
          episode
            ? (navigation) => (
                <PlayerView
                  player={player}
                  onAuthChanged={accountUpdated}
                  navigation={navigation}
                />
              )
            : undefined
        }
        onOpen={(id, userInitiated = true) => {
          window.history.replaceState(
            null,
            "",
            debugHref(`/space?episode=${encodeURIComponent(id)}`),
          );
          void (userInitiated ? playEpisode(id) : load(id)).catch((cause) =>
            setError(cause.message),
          );
        }}
      />
    );

  if (!episode)
    return (
      <Landing
        episodes={episodes}
        loading={episodesLoading}
        error={message(error)}
        spaceLink={!!accountUser}
        accountControl={
          <AccountControl onAuthChanged={accountUpdated} enterSpace />
        }
        open={(id) => {
          window.history.replaceState(null, "", debugHref(episodeHref(id)));
          void enter(id).catch((error) => setError(error.message));
        }}
      />
    );

  return (
    <div className="shell without-sidebar">
      <PlayerView
        player={player}
        onAuthChanged={accountUpdated}
        navigation={
          <>
            <a className="brand" href={homeHref()} aria-label="Aside">
              <span className="brand-word">Aside</span>
              <img
                className="brand-mark"
                src="/aside-mark.svg"
                alt=""
                aria-hidden="true"
              />
            </a>
            <LibraryDrawer
              collection="public"
              items={libraryFor(episodes, locale).map(audioCard)}
              label={t("公共音频库")}
              onOpen={(id) => {
                window.history.replaceState(null, "", debugHref(episodeHref(id)));
                void playEpisode(id).catch((error) => setError(error.message));
              }}
            />
          </>
        }
      />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
