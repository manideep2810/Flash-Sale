"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useEffect, useState } from "react";
import { BoltIcon, ClockIcon, TicketIcon, UsersIcon } from "@/components/Icons";
import { useSession } from "@/lib/session";

const USERNAME = /^[a-zA-Z0-9_-]{3,64}$/;

/** Only ever a path inside this app: `next` comes from the URL, which anyone can write. */
function safeNext(next: string | null): string {
  return next?.startsWith("/") && !next.startsWith("//") && !next.startsWith("/login") ? next : "/";
}

/**
 * The login screen. A username and a password, like any other; the backend's login is a development
 * one that takes the username alone, so the password is never sent anywhere and the screen says so.
 */
function LoginForm() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get("next"));
  const { ready, session, notice, login } = useSession();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  // Already logged in (or just now): on to where the user was going.
  useEffect(() => {
    if (ready && session) {
      router.replace(next);
    }
  }, [ready, session, router, next]);

  const name = username.trim();
  const nameProblem =
    name === ""
      ? "Enter a username."
      : USERNAME.test(name)
        ? null
        : "A username is 3 to 64 letters, digits, - or _.";
  const passwordProblem = password === "" ? "Enter a password." : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (nameProblem || passwordProblem || busy) {
      return;
    }
    setBusy(true);
    // The password stays here: the development login has no use for it.
    await login(name);
    setBusy(false);
  }

  return (
    <div className="auth">
      <aside className="auth__poster">
        <span className="brand__mark brand__mark--large">
          <BoltIcon size={28} />
        </span>
        <h2 className="auth__headline">
          Doors open.
          <br />
          Line forms here.
        </h2>
        <ul className="auth__points">
          <li>
            <UsersIcon size={18} /> A fair queue: join the lobby early and get a random place.
          </li>
          <li>
            <ClockIcon size={18} /> Your turn is yours: nobody can take it while the clock runs.
          </li>
          <li>
            <TicketIcon size={18} /> Tickets held for you while you pay.
          </li>
        </ul>
      </aside>

      <section className="auth__form">
        <h1>Log in</h1>
        <p className="muted">Welcome back. Log in to join a sale.</p>

        <form onSubmit={submit} noValidate>
          <label className="field">
            <span className="field__label">Username</span>
            <input
              name="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="alice"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={touched && nameProblem !== null}
            />
            {touched && nameProblem ? <span className="field__error">{nameProblem}</span> : null}
          </label>

          <label className="field">
            <span className="field__label">Password</span>
            <input
              name="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              aria-invalid={touched && passwordProblem !== null}
            />
            {touched && passwordProblem ? (
              <span className="field__error">{passwordProblem}</span>
            ) : (
              <span className="field__hint">
                Demo login: any password works, and it is never sent.
              </span>
            )}
          </label>

          {notice ? (
            <p className="alert" role="alert">
              {notice}
            </p>
          ) : null}

          <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
            {busy ? "Logging in…" : "Log in"}
          </button>
        </form>

        <p className="auth__alt">
          Running the sale? <Link href="/admin/login">Admin login</Link>
        </p>
      </section>
    </div>
  );
}

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary above it.
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
