"use client";

import { createContext, type ReactNode, useContext, useMemo, useRef } from "react";

export interface Turn {
  /** The admission token: what POST /api/reserve needs beside the session. */
  token: string;
  /** ISO time the turn ends. */
  expiresAt: string;
}

interface AdmissionContext {
  get(eventId: string): Turn | null;
  set(eventId: string, turn: Turn): void;
  clear(eventId: string): void;
}

const Context = createContext<AdmissionContext | null>(null);

/**
 * The user's turn for each event, IN MEMORY ONLY. Nothing here is ever written to sessionStorage or
 * localStorage: the token is a two-minute pass to buy, and a refresh gets it again from
 * GET /status for as long as the turn lasts.
 */
export function AdmissionProvider({ children }: { children: ReactNode }) {
  const turns = useRef(new Map<string, Turn>());
  const value = useMemo<AdmissionContext>(
    () => ({
      get: (eventId) => turns.current.get(eventId) ?? null,
      set: (eventId, turn) => {
        turns.current.set(eventId, turn);
      },
      clear: (eventId) => {
        turns.current.delete(eventId);
      },
    }),
    [],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAdmission(): AdmissionContext {
  const context = useContext(Context);
  if (!context) {
    throw new Error("useAdmission() needs an <AdmissionProvider>");
  }
  return context;
}
