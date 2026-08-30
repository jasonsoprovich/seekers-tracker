"use client";

import { useEffect, useRef, useState } from "react";

// Mirrors BidsPanel.tsx's own tier ordering (seekers-epgp-parser) — the
// live view should rank bids the same way the officer's "Determine
// Winner" will, so "who's currently ahead" here matches what actually
// gets marked the winner at finalize.
const TIER_RANK: Record<string, number> = { "High Bid": 4, "Medium Bid": 3, "Low Bid": 2, "Alt Loot": 1 };

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 20_000;

type LiveBidTell = {
  characterName: string;
  tier: string;
  occurredAt: string;
  priorityRating: number | null;
};

type LiveStatus = "live" | "idle";

// PLAN.md §15, multi-officer (2026-08-30): during a raid, 1-10 officers
// each run their own parser app and collect bids for different items in
// parallel. The DO now streams every open round at once; this view stacks
// them, each with the officer running it.
type RoundView = {
  itemName: string;
  officerName: string;
  bids: LiveBidTell[];
  status: LiveStatus;
  lastSeenAt: number;
};

type ServerMessage = { type: "state"; rounds: RoundView[] };

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

export function LiveBidsView() {
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [rounds, setRounds] = useState<RoundView[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(RECONNECT_BASE_MS);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
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
          if (msg.type === "state") setRounds(msg.rounds);
        } catch {
          // ignore a malformed frame rather than tearing down the socket
        }
      });

      socket.addEventListener("close", () => {
        if (cancelled) return;
        setConnection("closed");
        const delay = reconnectDelay.current;
        reconnectDelay.current = Math.min(delay * 2, RECONNECT_MAX_MS);
        reconnectTimer.current = setTimeout(connect, delay);
      });

      socket.addEventListener("error", () => socket.close());
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
        const msg = (await resp.json()) as ServerMessage;
        if (msg.type === "state") setRounds(msg.rounds);
      }
    } catch {
      // leave the current view as-is on a failed refresh
    } finally {
      setRefreshing(false);
    }
  }

  const anyLive = rounds.some((r) => r.status === "live");
  const pill =
    connection !== "open"
      ? { text: connection === "connecting" ? "Connecting…" : "Reconnecting…", cls: "bg-amber-500/15 text-amber-400" }
      : rounds.length === 0
        ? { text: "No live rounds", cls: "bg-neutral-700/40 text-neutral-400" }
        : anyLive
          ? { text: `${rounds.length} round${rounds.length === 1 ? "" : "s"} live`, cls: "bg-emerald-500/15 text-emerald-400" }
          : { text: "Idle — no officer app detected", cls: "bg-neutral-700/40 text-neutral-400" };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${pill.cls}`}>
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          {pill.text}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="ml-auto rounded-md border border-field px-3 py-1 text-xs font-medium text-neutral-300 transition-colors hover:bg-neutral-900/60 disabled:opacity-60"
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {rounds.length === 0 ? (
        <div className="rounded-lg border border-border px-3 py-6 text-center text-sm text-neutral-500">
          No live bid rounds right now — this fills in the moment an officer starts collecting tells.
        </div>
      ) : (
        <div className="space-y-6">
          {rounds.map((round) => {
            const ranked = sortedBids(round.bids);
            return (
              <div key={round.itemName}>
                <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <h2 className="text-lg font-semibold text-neutral-100">{round.itemName}</h2>
                  <span className="text-sm text-neutral-500">
                    collected by {round.officerName}
                    {round.status === "idle" && " · idle"}
                  </span>
                  <span className="ml-auto text-xs text-neutral-500">
                    last update {relativeTime(round.lastSeenAt, now)}
                  </span>
                </div>
                {ranked.length === 0 ? (
                  <div className="rounded-lg border border-border px-3 py-5 text-center text-sm text-neutral-500">No bids yet.</div>
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
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
