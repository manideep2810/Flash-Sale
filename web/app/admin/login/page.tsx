"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { ShieldIcon } from "@/components/Icons";
import { useSession } from "@/lib/session";

/** The admin login: one password, checked by the server, which issues a session marked as the admin's. */
export default function AdminLoginPage() {
  const router = useRouter();
  const { ready, isAdmin, notice, loginAsAdmin } = useSession();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (ready && isAdmin) {
      router.replace("/admin");
    }
  }, [ready, isAdmin, router]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || password === "") {
      return;
    }
    setBusy(true);
    await loginAsAdmin(password);
    setBusy(false);
  }

  return (
    <section className="panel panel--narrow">
      <span className="panel__icon">
        <ShieldIcon size={22} />
      </span>
      <h1 className="panel__title">Admin login</h1>
      <p className="muted">For whoever runs the sales: create events and watch the numbers.</p>

      <form onSubmit={submit} noValidate>
        <label className="field">
          <span className="field__label">Admin password</span>
          <input
            name="adminPassword"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />
        </label>
        {notice ? (
          <p className="alert" role="alert">
            {notice}
          </p>
        ) : null}
        <button
          type="submit"
          className="btn btn--primary btn--block"
          disabled={busy || password === ""}
        >
          {busy ? "Checking…" : "Log in as admin"}
        </button>
      </form>

      <p className="auth__alt">
        Here to buy tickets? <Link href="/login">Customer login</Link>
      </p>
    </section>
  );
}
