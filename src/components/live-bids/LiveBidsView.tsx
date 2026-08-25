"use client";

import { useEffect, useRef, useState } from "react";

// Mirrors BidsPanel.tsx's own tier ordering (seekers-epgp-parser) — the
// live view should rank bids the same way the officer's "Determine
// Winner" will, so "who's currently ahead" here matches what actually
// gets marked the winner at finalize.
const TIER_RANK: Record<string, number> = { "High Bid": 4, "Medium Bid": 3, "Low Bid": 2, "Alt Loot": 1 };

type LiveBidTell = {
  characterName: string;
  tier: string;
  occurredAt: string;
  priorityRating: number | null;
};

type ServerMessage = { type: "state"; itemName: string | null; bids: LiveBidTell[] } | { type: "cleared" };

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

// PLAN.md §15 / Phase 12 task 12.4. Read-only — this view never submits
// anything, it just renders what the officer app is pushing live
// (POST /api/officer/live-bids/push) and what a finalize clears
// (POST /api/officer/bids). Reconnects with a short fixed backoff since a
// raid-night connection can drop and come back over hours of watching.
export function LiveBidsView() {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [itemName, setItemName] = useState<string | null>(null);
  const [bids, setBids] = useState<LiveBidTell[]>([]);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;

    function connect() {
      if (cancelled) return;
      setStatus("connecting");
      socket = new WebSocket(wsUrl());

      socket.addEventListener("open", () => {
        if (!cancelled) setStatus("open");
      });

      socket.addEventListener("message", (event) => {
        try {
          const msg = JSON.parse(event.data) as ServerMessage;
          if (msg.type === "state") {
            setItemName(msg.itemName);
            setBids(msg.bids);
          } else if (msg.type === "cleared") {
            setItemName(null);
            setBids([]);
          }
        } catch {
          // ignore a malformed frame rather than tearing down the socket
        }
      });

      socket.addEventListener("close", () => {
        if (cancelled) return;
        setStatus("closed");
        reconnectTimer.current = setTimeout(connect, 3000);
      });

      socket.addEventListener("error", () => {
        socket?.close();
      });
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      socket?.close();
    };
  }, []);

  const ranked = sortedBids(bids);

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
            status === "open"
              ? "bg-emerald-500/15 text-emerald-400"
              : status === "connecting"
                ? "bg-amber-500/15 text-amber-400"
                : "bg-red-500/15 text-red-400"
          }`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          {status === "open" ? "Live" : status === "connecting" ? "Connecting…" : "Reconnecting…"}
        </span>
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
