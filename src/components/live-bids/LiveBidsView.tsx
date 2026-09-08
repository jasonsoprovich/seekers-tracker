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

// Dismiss is per-viewer (leader, 2026-09-05: one member closing a card
// must not close it for everyone else watching). The board itself (the
// Durable Object) has no per-viewer concept, so "dismissed" lives entirely
// in this browser's localStorage, keyed by item name, and is never sent to
// the server.
//
// We store the status the card had WHEN it was dismissed (post-live-test-1
// LT-05): a *resolved* dismissal sticks until the round ages off the board
// entirely — the viewer is done reviewing it. A
// *collecting* dismissal (a round that looks stuck because nobody
// finalized it) is lifted the moment it resolves, so the winner still
// surfaces. The previous version pruned every resolved dismissal on the
// next state frame, so "Dismiss" didn't survive a refresh at all.
const DISMISSED_STORAGE_KEY = "seekers.liveBids.dismissedItems";

type DismissedAt = "collecting" | "resolved";

function loadDismissed(): Map<string, DismissedAt> {
  const out = new Map<string, DismissedAt>();
  if (typeof window === "undefined") return out;
  try {
    const raw = window.localStorage.getItem(DISMISSED_STORAGE_KEY);
    if (!raw) return out;
    const parsed = JSON.parse(raw) as unknown;
    // Legacy shape: a bare string[]. Treat every entry as a sticky
    // (resolved) dismissal so nothing that was hidden pops back on upgrade.
    if (Array.isArray(parsed)) {
      for (const v of parsed) if (typeof v === "string") out.set(v, "resolved");
      return out;
    }
    if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (v === "collecting" || v === "resolved") out.set(k, v);
      }
    }
  } catch {
    // ignore — a private window / full storage just means dismiss doesn't
    // persist across reloads for this viewer, nothing breaks
  }
  return out;
}

function saveDismissed(map: Map<string, DismissedAt>) {
  try {
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {
    // best-effort — see loadDismissed
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
  // Maps item name -> the status it had when dismissed (see loadDismissed).
  const [dismissedKeys, setDismissedKeys] = useState<Map<string, DismissedAt>>(loadDismissed);
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

  // Purely local — hides this card from this browser only. Never touches
  // the server, so nobody else's board is affected and a live round keeps
  // running for everyone else.
  function onDismiss(itemName: string, status: LiveStatus) {
    setDismissedKeys((prev) => {
      const next = new Map(prev);
      next.set(itemName, status === "resolved" ? "resolved" : "collecting");
      saveDismissed(next);
      return next;
    });
  }

  // Lift a dismissal once hiding it no longer makes sense: the round left
  // the board entirely (server swept / cleared / aged off), or it was
  // dismissed *while collecting* and has since resolved — surface the
  // winner (they can re-dismiss). A dismissal made *at resolved* stays
  // until the round leaves the board. Also keeps the stored map from
  // growing over a long session.
  useEffect(() => {
    setDismissedKeys((prev) => {
      if (prev.size === 0) return prev;
      const onBoard = new Map(rounds.map((r) => [r.itemName, r.status] as const));
      const next = new Map<string, DismissedAt>();
      for (const [k, dismissedAt] of prev) {
        const status = onBoard.get(k);
        if (status === undefined) continue; // gone from the board
        if (dismissedAt === "collecting" && status === "resolved") continue; // show the winner
        next.set(k, dismissedAt);
      }
      if (next.size !== prev.size) saveDismissed(next);
      return next.size === prev.size ? prev : next;
    });
  }, [rounds]);

  // Active rounds (still collecting) sit above resolved ones; within each
  // group the most-recently-updated round comes first. (post-live-test-1:
  // resolved rounds were sorting to the top and pushing the live ones down.)
  const visibleRounds = useMemo(() => {
    const shown = rounds.filter((r) => {
      const dismissedAt = dismissedKeys.get(r.itemName);
      if (dismissedAt === undefined) return true;
      // A collecting-time dismissal is lifted once the round resolves.
      return !(dismissedAt === "resolved" || r.status !== "resolved");
    });
    const statusOrder = (s: LiveStatus) => (s === "resolved" ? 1 : 0);
    return shown.sort((a, b) => {
      const group = statusOrder(a.status) - statusOrder(b.status);
      return group !== 0 ? group : b.lastSeenAt - a.lastSeenAt;
    });
  }, [rounds, dismissedKeys]);

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
        // items-start: a card only grows to its own content. Without it the
        // grid stretches every card in a row to match the tallest, so
        // expanding one resolved card's bid list visually inflated its
        // neighbours (post-live-test-1 LT-01).
        <div
          className="grid items-start justify-start gap-4"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 320px), 480px))" }}
        >
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
                    {!resolved && (
                      <button
                        type="button"
                        onClick={() => onDismiss(round.itemName, round.status)}
                        title="Hides this card for you only until it resolves or is cleared — the round keeps running for everyone else"
                        className="self-center rounded border border-field px-2 py-0.5 text-[11px] text-neutral-400 transition-colors hover:bg-neutral-900/60"
                      >
                        Hide
                      </button>
                    )}
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
                        onClick={() => onDismiss(round.itemName, round.status)}
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
                          // Green (with a ✓) means "won" — only ever on a
                          // resolved round, after the officer has ended
                          // bidding and picked the winner. While a round is
                          // still collecting, the top-ranked row is just
                          // *leading* (amber) — it can still change, and a
                          // member shouldn't read it as "I won".
                          const isWinner = resolved && winnerNames.has(b.characterName.toLowerCase());
                          const isLeading = !resolved && i === 0;
                          return (
                            <tr
                              key={`${b.characterName}-${i}`}
                              className={
                                isWinner
                                  ? "bg-emerald-500/10"
                                  : isLeading
                                    ? "bg-amber-500/10"
                                    : "hover:bg-neutral-900/40"
                              }
                            >
                              <td className="px-4 py-2 font-medium">
                                {isWinner && <span className="mr-1 text-emerald-400">✓</span>}
                                {isLeading && (
                                  <span className="mr-1.5 rounded bg-amber-500/15 px-1 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-amber-400">
                                    leading
                                  </span>
                                )}
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
