"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { clearChunkReloadGuard } from "@/lib/chunk-reload";

// The build this bundle was compiled from — inlined at build time by
// next.config.ts's `env`. /api/health reports the build the *deployed*
// server is running. When they diverge, the code in this tab is stale:
// after a redeploy its lazy-loaded chunks 404 and navigation silently
// wedges. Rather than wait for the user to hit that, offer a reload.
//
// This is the proactive half of deploy-skew handling; src/lib/chunk-reload.ts
// (wired into the error boundaries) is the reactive fallback for a stale
// chunk that fails before the next poll.
const MY_BUILD = process.env.NEXT_PUBLIC_BUILD_ID ?? "";

const POLL_MS = 5 * 60 * 1000;

export function VersionGuard() {
  const [stale, setStale] = useState(false);
  const inFlight = useRef(false);

  const check = useCallback(async () => {
    if (stale || inFlight.current || !MY_BUILD) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    inFlight.current = true;
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { buildId?: string };
      if (data.buildId && data.buildId !== MY_BUILD) setStale(true);
    } catch {
      // transient network error — try again on the next tick, don't nag
    } finally {
      inFlight.current = false;
    }
  }, [stale]);

  useEffect(() => {
    // We rendered, so the current build booted fine — let the reactive
    // reload guard arm again for the next stale-chunk event.
    clearChunkReloadGuard();

    void check();
    const id = window.setInterval(() => void check(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [check]);

  if (!stale) return null;

  return (
    <div
      role="alert"
      style={{
        position: "fixed",
        insetInline: 0,
        bottom: 0,
        zIndex: 2147483647,
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.75rem",
        padding: "0.75rem 1rem",
        background: "#059669",
        color: "#000",
        fontSize: "0.875rem",
        fontWeight: 600,
        boxShadow: "0 -4px 16px rgba(0,0,0,0.35)",
      }}
    >
      <span>A new version of the site is available.</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{
          borderRadius: 9999,
          background: "#000",
          color: "#fff",
          padding: "0.35rem 0.9rem",
          fontWeight: 600,
          border: "none",
          cursor: "pointer",
        }}
      >
        Reload
      </button>
    </div>
  );
}
