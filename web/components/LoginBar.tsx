"use client";

import { type FormEvent, useState } from "react";
import { useSession } from "@/lib/session";

/**
 * On every page. Dev login: a user id and nothing else. Whoever you say you are, you are, for twelve
 * hours; the backend only issues these sessions outside production.
 */
export function LoginBar() {
  const { ready, session, notice, login, logout } = useSession();
  const [userId, setUserId] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    await login(userId.trim());
    setBusy(false);
  }

  if (!ready) {
    return <header className="bar" />;
  }
  if (session) {
    return (
      <header className="bar">
        <span>
          Logged in as <strong data-testid="user">{session.userId}</strong>
        </span>
        <button type="button" onClick={logout}>
          Log out
        </button>
      </header>
    );
  }
  return (
    <header className="bar">
      <form onSubmit={submit}>
        <label>
          User id{" "}
          <input
            name="userId"
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            placeholder="alice"
            autoComplete="off"
          />
        </label>
        <button type="submit" disabled={busy || userId.trim() === ""}>
          Log in
        </button>
      </form>
      {notice ? (
        <p className="notice" role="alert">
          {notice}
        </p>
      ) : null}
    </header>
  );
}
