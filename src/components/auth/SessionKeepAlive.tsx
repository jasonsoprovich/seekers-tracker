"use client";

import { useEffect } from "react";

import { authClient } from "@/lib/auth-client";

// Keeps the browser's session cookie in step with the database session.
//
// Every page reads the session in a Server Component (src/lib/session.ts),
// and a Server Component can't set cookies. better-auth still slides the
// session forward there (DB expires_at = now + 7 days once a day has passed
// since the last update), but the matching Set-Cookie is dropped — so the
// browser's cookie kept the Max-Age it got at sign-in and expired exactly
// 7 days after login however active you were, while the DB row lived on.
// Found 2026-11-18 from prod `sessions`: a Mac session created 11-11 21:12,
// extended in D1 on 11-15 to expire 11-22, yet a fresh sign-in at 11-18
// 23:49, about 2.5h after the original cookie lapsed.
//
// GET /api/auth/get-session is a real route handler, so its Set-Cookie
// reaches the browser: when the session is due for refresh it re-sets the
// session_token cookie with a fresh 7-day Max-Age, and it re-issues the
// 30-minute session_data cookie cache too (otherwise the cache also only
// ever works for the first 30 minutes after sign-in, since RSC can't renew
// it either). Called on load, when a tab comes back into view, and on a
// timer while visible, at most once per THROTTLE_MS per browser. Failures
// are ignored: this is best-effort upkeep, never the auth check itself.
const THROTTLE_MS = 15 * 60 * 1000;
const STORAGE_KEY = "session-keepalive-at";

function readLast(): number {
  try {
    return Number(window.localStorage.getItem(STORAGE_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeLast(ms: number) {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(ms));
  } catch {
    // storage unavailable (private window etc.) — the throttle just resets per load
  }
}

export function SessionKeepAlive() {
  useEffect(() => {
    let inFlight = false;
    let lastInMemory = 0;

    const refresh = () => {
      const now = Date.now();
      if (inFlight || now - Math.max(readLast(), lastInMemory) < THROTTLE_MS) return;
      inFlight = true;
      lastInMemory = now;
      writeLast(now);
      authClient
        .getSession()
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    };

    refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    // A tab left open (e.g. Live Bids all raid) never reloads or changes
    // visibility; the throttle keeps this to one request per THROTTLE_MS.
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, THROTTLE_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, []);

  return null;
}
