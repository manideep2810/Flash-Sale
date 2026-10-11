"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "@/lib/session";
import { BoltIcon } from "./Icons";

/** Where "Log in" sends you back to afterwards: the page you were on, unless that is a login page. */
function loginHref(pathname: string): string {
  const onLogin = pathname === "/login" || pathname === "/admin/login";
  return onLogin || pathname === "/" ? "/login" : `/login?next=${encodeURIComponent(pathname)}`;
}

/** On every page: the mark, the way to the events, and who is logged in. */
export function Header() {
  const pathname = usePathname() ?? "/";
  const { ready, session, isAdmin, logout } = useSession();
  const inAdmin = pathname.startsWith("/admin");

  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Link className="brand" href="/" aria-label="Flash sale: all events">
          <span className="brand__mark">
            <BoltIcon size={18} />
          </span>
          <span className="brand__name">
            flash<b>sale</b>
          </span>
        </Link>

        <nav className="site-nav" aria-label="Main">
          <Link href="/" aria-current={pathname === "/" ? "page" : undefined}>
            Events
          </Link>
          {isAdmin ? (
            <Link href="/admin" aria-current={inAdmin ? "page" : undefined}>
              Admin
            </Link>
          ) : null}
        </nav>

        <div className="site-header__account">
          {!ready ? null : session ? (
            <>
              <span className="account" title={`Logged in as ${session.userId}`}>
                <span className="account__avatar" aria-hidden="true">
                  {session.userId.charAt(0).toUpperCase()}
                </span>
                <span className="visually-hidden">Logged in as </span>
                <span className="account__name" data-testid="user">
                  {session.userId}
                </span>
              </span>
              <button type="button" className="btn btn--ghost btn--small" onClick={logout}>
                Log out
              </button>
            </>
          ) : pathname === "/login" ? null : (
            <Link className="btn btn--dark btn--small" href={loginHref(pathname)}>
              Log in
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
