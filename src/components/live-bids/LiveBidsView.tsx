"use client";

import { useEffect, useRef, useState } from "react";

// Mirrors BidsPanel.tsx's own tier ordering (seekers-epgp-parser) — the
// live view should rank bids the same way the officer's "Determine
// Winner" will, so "who's currently ahead" here matches what actually
// gets marked the winner at finalize.
const TIER_RANK: Record<string, number> = { "High Bid": 4, "Medium Bid": 3, "Low Bid": 2, "Alt Loot": 1 };

// TTL_MS on the DO side is 90s — reconnect/backoff timing here is
// independent of that (a viewer's socket dropping is unrelated to whether
// an officer is still pushing), but keeping it in the same ballpark means
// a reconnect after a brief network blip doesn't itself cause a spurious
// "Idle" flash before the fresh state message arrives.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 20_000;

type LiveBidTell = {
  characterName: string;
  tier: string;
  occurredAt: string;
  priorityRating: number | null;
};

type LiveStatus = "live" | "idle";

type ServerMessage =
  | { type: "state"; itemName: string | null; bids: LiveBidTell[]; status: LiveStatus; lastSeenAt: number | null }
  | { type: "cleared" };

type ConnectionStatus = "connecting" | "open" | "closed";

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/live-bids/ws`;
}

function sortedBids(bids: LiveBidTell[]): LiveBidTell[] {
  return bids.slice().sort((a, b) => {
    const rankDiff = (TIER_RANK[b.tier] ?? 0) - (TIER_RANK[a.tier] ?? 0);
    if (rankDiff !== 0) return rankDiff;
    return (b.priorityRating ?? -Infinity) - (a.priorityRating ?? -Infinity);
  });
}

function relativeTime(ms: number | null, now: number): string {
  if (ms === null) return "never";
  const deltaS = Math.max(0, Math.round((now - ms) / 1000));
  if (deltaS < 5) return "just now";
  if (deltaS < 60) return `${deltaS}s ago`;
  const deltaM = Math.round(deltaS / 60);
  if (deltaM < 60) return `${deltaM}m ago`;
  return `${Math.round(deltaM / 60)}h ago`;
}

// PLAN.md §15 / Phase 12 task 12.4, extended 2026-08-25 with idle
// detection + a manual refresh. Read-only — this view never submits
// anything, it just renders what the officer app is pushing/heartbeating
// live (POST /api/officer/live-bids/{push,heartbeat}) and what a finalize
// clears (POST /api/officer/bids).
//
// Before this: the pill only ever reflected socket state, so an open
// socket against a DO holding a stale round (officer closed the app hours
// ago) showed a confident green "Live." Now the DO itself reports
// status:"live"|"idle" based on when it last heard from an officer
// (TTL_MS in the DO, 90s), and the pill reflects that instead of just
// "is my WebSocket open."
export function LiveBidsView() {
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [itemName, setItemName] = useState<string | null>(null);
  const [bids, setBids] = useState<LiveBidTell[]>([]);
  const [liveStatus, setLiveStatus] = useState<LiveStatus | null>(null);
  const [lastSeenAt, setLastSeenAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(RECONNECT_BASE_MS);
  const socketRef = useRef<WebSocket | null>(null);

  function applyState(msg: Extract<ServerMessage, { type: "state" }>) {
    setItemName(msg.itemName);
    setBids(msg.bids);
    setLiveStatus(msg.status);
    setLastSeenAt(msg.lastSeenAt);
  }

  useEffect(() => {
    // Ticks the relative "last update" label without needing a fresh
    // server message — a round that's gone quiet should still visibly age
    // ("3s ago" -> "1m ago") for a viewer just watching the page.
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      setConnection("connecting");
      const socket = new WebSocket(wsUrl());
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        if (cancelled) return;
        setConnection("open");
        reconnectDelay.current = RECONNECT_BASE_MS;
      });

      socket.addEventListener("message", (event) => {
        try {
          const msg = JSON.parse(event.data) as ServerMessage;
          if (msg.type === "state") {
            applyState(msg);
          } else if (msg.type === "cleared") {
            setItemName(null);
            setBids([]);
            setLiveStatus(null);
            setLastSeenAt(null);
          }
        } catch {
          // ignore a malformed frame rather than tearing down the socket
        }
      });

      socket.addEventListener("close", () => {
        if (cancelled) return;
        setConnection("closed");
        // Exponential backoff with a cap — previously a fixed 3s retry
        // forever, so a 401/403 (e.g. membership revoked mid-session)
        // retried indefinitely at a constant rate. Still retries
        // indefinitely (a real raid-night connection can drop and come
        // back over hours of watching), just backing off instead of
        // hammering.
        const delay = reconnectDelay.current;
        reconnectDelay.current = Math.min(delay * 2, RECONNECT_MAX_MS);
        reconnectTimer.current = setTimeout(connect, delay);
      });

      socket.addEventListener("error", () => {
        socket.close();
      });
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      socketRef.current?.close();
    };
  }, []);

  async function onRefresh() {
    setRefreshing(true);
    try {
      const resp = await fetch("/api/live-bids/state");
      if (resp.ok) {
        const msg = (await resp.json()) as Extract<ServerMessage, { type: "state" }>;
        applyState(msg);
      }
    } catch {
      // leave the current view as-is on a failed refresh
    } finally {
      setRefreshing(false);
    }
  }

  const ranked = sortedBids(bids);

  const pill =
    connection !== "open"
      ? { text: connection === "connecting" ? "Connecting…" : "Reconnecting…", cls: "bg-amber-500/15 text-amber-400" }
      : liveStatus === "live"
        ? { text: "Live", cls: "bg-emerald-500/15 text-emerald-400" }
        : { text: "Idle — no officer app detected", cls: "bg-neutral-700/40 text-neutral-400" };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${pill.cls}`}>
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          {pill.text}
        </span>
        {connection === "open" && <span className="text-xs text-neutral-500">Last update: {relativeTime(lastSeenAt, now)}</span>}
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="ml-auto rounded-md border border-field px-3 py-1 text-xs font-medium text-neutral-300 transition-colors hover:bg-neutral-900/60 disabled:opacity-60"
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {itemName ? (
        <>
          <h2 className="mb-3 text-lg font-semibold text-neutral-100">{itemName}</h2>
          {ranked.length === 0 ? (
            <div className="rounded-lg border border-border px-3 py-6 text-center text-sm text-neutral-500">No bids yet.</div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[520px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
                    <th className="px-3 py-2 font-medium">Character</th>
                    <th className="px-3 py-2 font-medium">Tier</th>
                    <th className="px-3 py-2 font-medium">Priority</th>
                    <th className="px-3 py-2 font-medium">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {ranked.map((b, i) => (
                    <tr key={`${b.characterName}-${i}`} className={i === 0 ? "bg-emerald-500/10" : "hover:bg-neutral-900/40"}>
                      <td className="px-3 py-2 font-medium">{b.characterName}</td>
                      <td className="px-3 py-2 text-neutral-400">{b.tier}</td>
                      <td className="px-3 py-2 text-neutral-400">{b.priorityRating !== null ? b.priorityRating.toFixed(2) : "—"}</td>
                      <td className="px-3 py-2 text-neutral-400">{new Date(b.occurredAt).toLocaleTimeString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <div className="rounded-lg border border-border px-3 py-6 text-center text-sm text-neutral-500">
          No live bid round right now — this fills in the moment an officer starts collecting tells.
        </div>
      )}
    </div>
  );
}
