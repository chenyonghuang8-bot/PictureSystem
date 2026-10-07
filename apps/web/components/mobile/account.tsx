"use client";
import { useState } from "react";
export function AccountForm({ signedIn = false }: { signedIn?: boolean }) {
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  async function send(path: string, body: unknown, logout = false) {
    setBusy(true);
    setMessage("");
    try {
      const r = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error();
      if (logout) {
        window.dispatchEvent(new Event("family-auth-lost"));
        window.location.replace("/login");
      } else window.location.replace("/");
    } catch {
      setMessage(
        "操作未确认，请检查账号密码后重试。重新验证结果未知时请重新登录。",
      );
    } finally {
      setBusy(false);
      setPassword("");
    }
  }
  return (
    <form
      className="mobile-account"
      onSubmit={(e) => {
        e.preventDefault();
        void send(
          signedIn ? "/api/v1/auth/reauth" : "/api/v1/auth/login",
          signedIn ? { password } : { username, password },
        );
      }}
    >
      {!signedIn ? (
        <label>
          账号
          <input
            name="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </label>
      ) : null}
      <label>
        {signedIn ? "重新验证密码" : "密码"}
        <input
          name="password"
          type="password"
          autoComplete={signedIn ? "off" : "current-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      <button disabled={busy}>{signedIn ? "重新验证" : "登录"}</button>
      {signedIn ? (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => void send("/api/v1/auth/logout", {}, true)}
          >
            退出登录
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void send("/api/v1/auth/logout-all", {}, true)}
          >
            退出所有设备
          </button>
        </>
      ) : null}
      {message ? <p role="alert">{message}</p> : null}
    </form>
  );
}
