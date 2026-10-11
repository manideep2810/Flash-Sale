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
import { adminLogin, configureApi, devLogin, toFailure } from "./api";

export interface UserSession {
  userId: string;
  token: string;
  /** ISO time. */
  expiresAt: string;
  /** "admin" for a session the admin login issued. A customer's has none. */
  role?: string;
}

interface SessionContext {
  /** False until sessionStorage has been read: pages wait for it before deciding there is no session. */
  ready: boolean;
  session: UserSession | null;
  /** True when the session is the admin's. */
  isAdmin: boolean;
  /** Why there is no session, when it is not simply a first visit: it ended, or a login failed. */
  notice: string | null;
  /** Resolves to whether it worked; when it did not, `notice` says why. */
  login(userId: string): Promise<boolean>;
  loginAsAdmin(password: string): Promise<boolean>;
  logout(): void;
}

const STORAGE_KEY = "flash.session";
const Context = createContext<SessionContext | null>(null);

/**
 * The session: who is logged in. Held in memory and mirrored to sessionStorage, so a refresh keeps you
 * logged in and closing the tab does not. (The admission token is a different thing and is never
 * stored: see lib/admission.tsx.) There is one session at a time: logging in as the admin replaces a
 * customer's, and the other way round.
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

  const keep = useCallback((next: UserSession) => {
    token.current = next.token;
    setSession(next);
    setNotice(null);
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Logged in for this page view only.
    }
  }, []);

  useEffect(() => {
    configureApi({
      getSessionToken: () => token.current,
      // Any 401 for want of a session: logged out, with the reason for the login screen to show.
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

  const login = useCallback(
    async (userId: string) => {
      try {
        const issued = await devLogin(userId);
        keep({ userId, token: issued.token, expiresAt: issued.expiresAt });
        return true;
      } catch (error) {
        const failure = toFailure(error);
        setNotice(
          failure.code === "BAD_REQUEST"
            ? "A username is 3 to 64 letters, digits, - or _."
            : failure.message,
        );
        return false;
      }
    },
    [keep],
  );

  const loginAsAdmin = useCallback(
    async (password: string) => {
      try {
        const issued = await adminLogin(password);
        keep({
          userId: "admin",
          token: issued.token,
          expiresAt: issued.expiresAt,
          role: issued.role,
        });
        return true;
      } catch (error) {
        setNotice(toFailure(error).message);
        return false;
      }
    },
    [keep],
  );

  const logout = useCallback(() => forget(null), [forget]);

  const value = useMemo(
    () => ({
      ready,
      session,
      isAdmin: session?.role === "admin",
      notice,
      login,
      loginAsAdmin,
      logout,
    }),
    [ready, session, notice, login, loginAsAdmin, logout],
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
