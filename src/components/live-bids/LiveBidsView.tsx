"use client";

import { useEffect, useMemo, useRef, useState } from "react";

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

type LiveStatus = "live" | "idle" | "resolved";

// PLAN.md §15, multi-officer (2026-08-30) + §16 resolved rounds
// (2026-09-01): during a raid, 1-10 officers each run their own parser app
// and collect bids for different items in parallel. The DO streams every
// open round at once plus recently-finalized ("resolved") rounds, each
// tagged with the officer running it; this view lays them out as an
// auto-sizing grid.
type RoundView = {
  itemName: string;
  officerName: string;
  bids: LiveBidTell[];
  winners: LiveBidTell[];
  status: LiveStatus;
  lastSeenAt: number;
};

type ServerMessage = { type: "state"; rounds: RoundView[] };

type ConnectionStatus = "connecting" | "open" | "closed";

// Dismiss is per-viewer (leader, 2026-09-05: one member closing a resolved
// card must not close it for everyone else watching). The board itself
// (the Durable Object) has no per-viewer concept, so "dismissed" lives
// entirely in this browser's localStorage, keyed by item name, and only
// ever hides a *currently resolved* round from this render — it's never
// sent to the server. A round naturally reappears if the same item name
// goes live again later (a fresh round object, no longer "resolved"), and
// dismissed keys are pruned to whatever's still actually resolved so this
// doesn't grow unbounded over a long session.
const DISMISSED_STORAGE_KEY = "seekers.liveBids.dismissedItems";

function loadDismissed(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(DISMISSED_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function saveDismissed(keys: Set<string>) {
  try {
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // best-effort — a private window or full storage just means dismiss
    // doesn't persist across reloads for this viewer, nothing breaks
  }
}

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

function StatusPill({ status }: { status: LiveStatus }) {
  const map = {
    live: { text: "Live", cls: "bg-emerald-500/15 text-emerald-400" },
    idle: { text: "Idle", cls: "bg-neutral-700/40 text-neutral-400" },
    resolved: { text: "Resolved", cls: "bg-sky-500/15 text-sky-300" },
  } as const;
  const p = map[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${p.cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full bg-current ${status === "live" ? "animate-pulse" : ""}`} />
      {p.text}
    </span>
  );
}

export function LiveBidsView() {
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [rounds, setRounds] = useState<RoundView[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  // Lazy initializer so this reads localStorage once, client-side only.
  const [dismissedKeys, setDismissedKeys] = useState<Set<string>>(loadDismissed);
  // Resolved cards render collapsed (winner line only) until the viewer
  // opens them — the point of the board is watching what's live, not
  // re-reading finished rounds. Collecting cards are always expanded.
  const [openBids, setOpenBids] = useState<Record<string, boolean>>({});
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(RECONNECT_BASE_MS);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Hydrate immediately on mount from the DO's REST snapshot, in parallel
  // with the WebSocket handshake — so navigating away and back shows the
  // open + resolved rounds right away instead of a blank "Connecting…"
  // gap while the socket comes up.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/live-bids/state")
      .then((r) => (r.ok ? r.json() : null))
      .then((raw) => {
        const msg = raw as ServerMessage | null;
        if (!cancelled && msg?.type === "state") setRounds((cur) => (cur.length === 0 ? msg.rounds : cur));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
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

  // Purely local — hides this resolved card from this browser only. Never
  // touches the server, so nobody else's board is affected.
  function onDismiss(itemName: string) {
    setDismissedKeys((prev) => {
      const next = new Set(prev);
      next.add(itemName);
      saveDismissed(next);
      return next;
    });
  }

  // Drop any dismissed key that's no longer a currently-resolved round —
  // either the server swept it, or it went live again under the same item
  // name — so a re-announced item isn't hidden forever and the stored set
  // doesn't grow across a long session.
  useEffect(() => {
    setDismissedKeys((prev) => {
      if (prev.size === 0) return prev;
      const stillResolved = new Set(rounds.filter((r) => r.status === "resolved").map((r) => r.itemName));
      const next = new Set([...prev].filter((k) => stillResolved.has(k)));
      if (next.size !== prev.size) saveDismissed(next);
      return next.size === prev.size ? prev : next;
    });
  }, [rounds]);

  const visibleRounds = useMemo(
    () => rounds.filter((r) => r.status !== "resolved" || !dismissedKeys.has(r.itemName)),
    [rounds, dismissedKeys],
  );

  const liveCount = visibleRounds.filter((r) => r.status === "live").length;
  const resolvedCount = visibleRounds.filter((r) => r.status === "resolved").length;

  let pill: { text: string; cls: string };
  if (connection !== "open") {
    pill = { text: connection === "connecting" ? "Connecting…" : "Reconnecting…", cls: "bg-amber-500/15 text-amber-400" };
  } else if (visibleRounds.length === 0) {
    pill = { text: "No live rounds", cls: "bg-neutral-700/40 text-neutral-400" };
  } else {
    const parts: string[] = [];
    if (liveCount) parts.push(`${liveCount} live`);
    if (resolvedCount) parts.push(`${resolvedCount} resolved`);
    if (!liveCount && !resolvedCount) parts.push("idle");
    pill = { text: parts.join(" · "), cls: liveCount ? "bg-emerald-500/15 text-emerald-400" : "bg-neutral-700/40 text-neutral-400" };
  }

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

      {visibleRounds.length === 0 ? (
        <div className="rounded-lg border border-border px-3 py-6 text-center text-sm text-neutral-500">
          No live bid rounds right now — this fills in the moment an officer starts collecting tells.
        </div>
      ) : (
        <div className="grid justify-start gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 320px), 480px))" }}>
          {visibleRounds.map((round) => {
            const ranked = sortedBids(round.bids);
            const resolved = round.status === "resolved";
            const winnerNames = new Set(round.winners.map((w) => w.characterName.toLowerCase()));
            // Collecting rounds: always show the table. Resolved rounds:
            // collapsed unless the viewer opened this one.
            const showTable = !resolved || openBids[round.itemName];
            return (
              <article
                key={round.itemName}
                className={`flex flex-col rounded-xl border ${
                  resolved ? "border-sky-500/25 bg-sky-500/[0.03]" : "border-border bg-neutral-900/30"
                }`}
              >
                <header className="border-b border-border px-4 py-3">
                  <div className="flex items-start gap-2">
                    <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-neutral-100" title={round.itemName}>
                      {round.itemName}
                    </h2>
                    <StatusPill status={round.status} />
                  </div>
                  <div className="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs text-neutral-500">
                    <span>collected by {round.officerName}</span>
                    <span className="ml-auto">
                      {resolved ? "finalized" : "updated"} {relativeTime(round.lastSeenAt, now)}
                    </span>
                  </div>
                  {resolved && (
                    <div className="mt-2 flex items-center gap-2">
                      <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-400">
                        WON
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">
                        {round.winners.length ? round.winners.map((w) => w.characterName).join(", ") : "—"}
                      </span>
                      <button
                        type="button"
                        onClick={() => onDismiss(round.itemName)}
                        title="Hides this card for you only — everyone else watching keeps seeing it"
                        className="rounded border border-field px-2 py-0.5 text-[11px] text-neutral-400 transition-colors hover:bg-neutral-900/60"
                      >
                        Dismiss
                      </button>
                    </div>
                  )}
                </header>

                {resolved && ranked.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setOpenBids((o) => ({ ...o, [round.itemName]: !o[round.itemName] }))}
                    className="border-b border-border px-4 py-2 text-left text-xs font-medium text-neutral-400 transition-colors hover:bg-neutral-900/40"
                  >
                    {showTable ? "▾ Hide bids" : `▸ Show all ${ranked.length} bid${ranked.length === 1 ? "" : "s"}`}
                  </button>
                )}

                {ranked.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-neutral-500">No bids{resolved ? " were recorded" : " yet"}.</div>
                ) : !showTable ? null : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-border text-[11px] uppercase tracking-wide text-neutral-500">
                          <th className="px-4 py-2 font-medium">Character</th>
                          <th className="px-4 py-2 font-medium">Bid</th>
                          <th className="px-4 py-2 font-medium">Prio</th>
                          <th className="px-4 py-2 font-medium">Time</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {ranked.map((b, i) => {
                          const isWinner = resolved
                            ? winnerNames.has(b.characterName.toLowerCase())
                            : i === 0;
                          return (
                            <tr
                              key={`${b.characterName}-${i}`}
                              className={isWinner ? "bg-emerald-500/10" : "hover:bg-neutral-900/40"}
                            >
                              <td className="px-4 py-2 font-medium">
                                {isWinner && resolved && <span className="mr-1 text-emerald-400">✓</span>}
                                {b.characterName}
                              </td>
                              <td className="px-4 py-2 text-neutral-400">{b.tier}</td>
                              <td className="px-4 py-2 tabular-nums text-neutral-400">
                                {b.priorityRating !== null ? b.priorityRating.toFixed(4) : "—"}
                              </td>
                              <td className="px-4 py-2 tabular-nums text-neutral-400">
                                {new Date(b.occurredAt).toLocaleTimeString()}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
