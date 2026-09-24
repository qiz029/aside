import { useEffect, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { t } from "./i18n";
import "./account.css";

export interface User {
  id: string;
  email: string;
  alias: string;
  description: string;
  avatarUrl: string | null;
}
interface Session {
  user: User | null;
  googleEnabled: boolean;
  appleWebEnabled?: boolean;
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw Error(body?.error ?? t("请求失败，请重试"));
  }
  return response.json();
}
export function AccountControl({
  onAuthChanged,
  onUserChanged,
  enterSpace = false,
}: {
  onAuthChanged: () => Promise<void>;
  onUserChanged?: (user: User | null) => void;
  enterSpace?: boolean;
}) {
  const [session, setSession] = useState<Session>();
  const [sessionFailed, setSessionFailed] = useState(false);
  const [view, setView] = useState<"closed" | "login" | "profile">("closed");
  const [alias, setAlias] = useState("");
  const [description, setDescription] = useState("");
  const [avatarVersion, setAvatarVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void request<Session>("/api/auth/session")
      .then((next) => {
        if (!active) return;
        setSession(next);
        setAlias(next.user?.alias ?? "");
        setDescription(next.user?.description ?? "");
        const params = new URL(location.href).searchParams;
        if (next.user && params.has("profile")) {
          setView("profile");
          history.replaceState(null, "", location.pathname);
          void onAuthChanged();
        }
      })
      .catch(() => {
        if (active) setSessionFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);
  const user = session?.user;
  useEffect(() => {
    onUserChanged?.(
      user
        ? {
            ...user,
            avatarUrl: user.avatarUrl?.startsWith("/api/")
              ? `${user.avatarUrl}${user.avatarUrl.includes("?") ? "&" : "?"}v=${avatarVersion}`
              : user.avatarUrl,
          }
        : null,
    );
  }, [user, avatarVersion, onUserChanged]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("请求失败，请重试"));
    } finally {
      setBusy(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      const next = await request<{ user: User }>("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alias, description }),
      });
      setSession((previous) =>
        previous ? { ...previous, user: next.user } : previous,
      );
      setView("closed");
      await onAuthChanged();
    });
  }
  async function avatar(file?: File) {
    if (!file) return;
    await run(async () => {
      if (file.size > 2 * 1024 * 1024) throw Error(t("头像不能超过 2 MB"));
      await request("/api/profile/avatar", {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      setSession((previous) =>
        previous?.user
          ? {
              ...previous,
              user: { ...previous.user, avatarUrl: "/api/profile/avatar" },
            }
          : previous,
      );
      setAvatarVersion((version) => version + 1);
      await onAuthChanged();
    });
  }
  async function logout() {
    await run(async () => {
      await request("/api/auth/logout", { method: "POST" });
      setSession((previous) =>
        previous ? { ...previous, user: null } : previous,
      );
      setView("closed");
      await onAuthChanged();
    });
  }
  return (
    <>
      {user && enterSpace ? (
        <a className="account-trigger btn btn-secondary" href="/space">
          Enter My Space
        </a>
      ) : (
        <button
          className="account-trigger btn btn-secondary"
          onClick={() => {
            setError("");
            setView(user ? "profile" : "login");
          }}
          aria-label={user ? t("编辑个人资料") : t("登录 / 注册")}
        >
          {user ? (
            <>
              <span className="account-avatar-small">
                {user.avatarUrl ? (
                  <img
                    src={
                      user.avatarUrl +
                      (user.avatarUrl.startsWith("/api/")
                        ? `?v=${avatarVersion}`
                        : "")
                    }
                    alt=""
                  />
                ) : (
                  user.alias.slice(0, 1).toUpperCase()
                )}
              </span>
              <span>{user.alias}</span>
            </>
          ) : (
            t("登录 / 注册")
          )}
        </button>
      )}
      {view !== "closed" &&
        createPortal(
          <div
            className="account-overlay"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setView("closed");
            }}
          >
            <section
              className="account-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="account-title"
            >
              <div className="account-head">
                <span className="account-badge" aria-hidden="true">
                  <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  >
                    <path d="M3 6v4M6 3.5v9M10 5v6M13 7v2" />
                  </svg>
                </span>
                <button
                  className="account-close btn btn-quiet btn-icon btn-sm"
                  aria-label={t("关闭")}
                  onClick={() => setView("closed")}
                >
                  <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <path d="m4 4 8 8M12 4l-8 8" />
                  </svg>
                </button>
              </div>
              {view === "login" ? (
                <>
                  <div className="account-intro">
                    <h2 id="account-title">{t("从这里继续听")}</h2>
                    <p>{t("登录后保存你的音频和收听进度。")}</p>
                  </div>
                  {session?.appleWebEnabled && (
                    <a
                      className="account-apple btn btn-lg btn-block"
                      href="/api/auth/apple"
                    >
                      <svg
                        className="account-apple-logo"
                        viewBox="0 0 814 1000"
                        aria-hidden="true"
                      >
                        <path
                          fill="currentColor"
                          d="M788 341c-6 4-108 62-108 190 0 149 131 201 135 203-1 3-21 72-69 142-43 62-88 124-156 124s-86-40-164-40c-77 0-104 41-167 41s-106-58-156-129C45 789 0 664 0 546 0 356 124 255 246 255c65 0 119 43 160 43 39 0 100-45 174-45 28 0 129 2 196 88ZM559 164c31-37 53-88 53-139 0-7-1-14-2-20-50 2-110 34-146 76-28 32-55 83-55 135 0 8 1 15 2 18 3 1 8 1 13 1 45 0 102-30 135-71Z"
                        />
                      </svg>
                      {t("使用 Apple 登录")}
                    </a>
                  )}
                  {session?.googleEnabled && (
                    <a
                      className="account-google btn btn-secondary btn-lg btn-block"
                      href="/api/auth/google"
                    >
                      <span className="account-g" aria-hidden="true">
                        G
                      </span>
                      {t("使用 Google 登录")}
                    </a>
                  )}
                  {!session && (
                    <p role="status">
                      {sessionFailed
                        ? t("登录服务暂时不可用，请稍后刷新重试。")
                        : t("请稍候…")}
                    </p>
                  )}
                  {session &&
                    !session.appleWebEnabled &&
                    !session.googleEnabled && <p>{t("登录服务尚未配置")}</p>}
                </>
              ) : (
                <>
                  <h2 id="account-title">{t("个人资料")}</h2>
                  <form onSubmit={save}>
                    <label className="account-avatar-picker">
                      <span className="account-avatar-large">
                        {user?.avatarUrl ? (
                          <img
                            src={
                              user.avatarUrl +
                              (user.avatarUrl.startsWith("/api/")
                                ? `?v=${avatarVersion}`
                                : "")
                            }
                            alt=""
                          />
                        ) : (
                          user?.alias.slice(0, 1).toUpperCase()
                        )}
                      </span>
                      <span>
                        {t("更换头像")}
                        <small>PNG / JPEG / WebP · 2 MB</small>
                      </span>
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        onChange={(event) =>
                          void avatar(event.target.files?.[0])
                        }
                        disabled={busy}
                      />
                    </label>
                    <label htmlFor="account-alias">{t("昵称")}</label>
                    <input
                      id="account-alias"
                      className="input"
                      value={alias}
                      onChange={(event) => setAlias(event.target.value)}
                      maxLength={40}
                      required
                    />
                    <label htmlFor="account-description">{t("介绍")}</label>
                    <textarea
                      id="account-description"
                      className="input"
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      maxLength={500}
                      rows={4}
                      placeholder={t("说说你喜欢听什么…")}
                    />
                    <small className="account-email">{user?.email}</small>
                    <button
                      className="account-primary btn btn-primary btn-lg btn-block"
                      disabled={busy}
                    >
                      {busy ? t("请稍候…") : t("保存资料")}
                    </button>
                  </form>
                  <button
                    className="account-text btn btn-quiet btn-sm"
                    onClick={() => void logout()}
                    disabled={busy}
                  >
                    {t("退出登录")}
                  </button>
                  {session?.googleEnabled && (
                    <a
                      className="account-text btn btn-quiet btn-sm"
                      href="/api/auth/google"
                    >
                      {t("关联 Google 账号")}
                    </a>
                  )}
                </>
              )}
              {error && (
                <p className="account-error" role="alert">
                  {error}
                </p>
              )}
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
