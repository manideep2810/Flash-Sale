"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { configureApi, devLogin, toFailure } from "./api";

export interface UserSession {
  userId: string;
  token: string;
  /** ISO time. */
  expiresAt: string;
}

interface SessionContext {
  /** False until sessionStorage has been read: pages wait for it before deciding there is no session. */
  ready: boolean;
  session: UserSession | null;
  /** Why the login bar is showing, when it is not simply a first visit. */
  notice: string | null;
  login(userId: string): Promise<void>;
  logout(): void;
}

const STORAGE_KEY = "flash.session";
const Context = createContext<SessionContext | null>(null);

/**
 * The session: who is logged in. Held in memory and mirrored to sessionStorage, so a refresh keeps you
 * logged in and closing the tab does not. (The admission token is a different thing and is never
 * stored: see lib/admission.tsx.)
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<UserSession | null>(null);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // The API client reads the token from here, so a call made right after login already carries it.
  const token = useRef<string | null>(null);

  const forget = useCallback((why: string | null) => {
    token.current = null;
    setSession(null);
    setNotice(why);
    try {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage can be unavailable (private mode); the in-memory session is already gone.
    }
  }, []);

  useEffect(() => {
    configureApi({
      getSessionToken: () => token.current,
      // Any 401 for want of a session: back to the login bar, with the reason.
      onSessionRejected: () => forget("Your session ended. Log in again."),
    });
    try {
      const stored = window.sessionStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as UserSession;
        if (parsed.token && parsed.userId && Date.parse(parsed.expiresAt) > Date.now()) {
          token.current = parsed.token;
          setSession(parsed);
        }
      }
    } catch {
      // Nothing usable stored.
    }
    setReady(true);
  }, [forget]);

  const login = useCallback(async (userId: string) => {
    try {
      const issued = await devLogin(userId);
      const next: UserSession = { userId, token: issued.token, expiresAt: issued.expiresAt };
      token.current = next.token;
      setSession(next);
      setNotice(null);
      try {
        window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Logged in for this page view only.
      }
    } catch (error) {
      const failure = toFailure(error);
      setNotice(
        failure.code === "BAD_REQUEST"
          ? "A user id is 3 to 64 letters, digits, - or _."
          : failure.message,
      );
    }
  }, []);

  const logout = useCallback(() => forget(null), [forget]);

  const value = useMemo(
    () => ({ ready, session, notice, login, logout }),
    [ready, session, notice, login, logout],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSession(): SessionContext {
  const context = useContext(Context);
  if (!context) {
    throw new Error("useSession() needs a <SessionProvider>");
  }
  return context;
}
