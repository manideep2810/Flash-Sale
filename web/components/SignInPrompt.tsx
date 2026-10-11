"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "@/lib/session";
import { LockIcon } from "./Icons";

/**
 * What a page that needs a session shows without one: why, and the way to the login screen, which
 * brings the user back here. When the session ended by itself (it expired, or the server refused it)
 * the reason is the session's notice.
 */
export function SignInPrompt({ what }: { what: string }) {
  const pathname = usePathname() ?? "/";
  const { notice } = useSession();
  return (
    <section className="panel panel--center">
      <span className="panel__icon">
        <LockIcon size={22} />
      </span>
      <h1 className="panel__title">Log in {what}</h1>
      {notice ? (
        <p className="alert" role="alert">
          {notice}
        </p>
      ) : (
        <p className="muted">It takes a username and a few seconds.</p>
      )}
      <Link className="btn btn--primary" href={`/login?next=${encodeURIComponent(pathname)}`}>
        Log in
      </Link>
    </section>
  );
}
