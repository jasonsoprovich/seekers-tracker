"use client";

import { useMemo, useState } from "react";

import { fieldClasses } from "@/components/ui/Field";
import { SortableTh, useTableSort } from "@/components/ui/table-sort";
import { guildDate } from "@/lib/guild-timezone";
import type { TotalsRow } from "@/lib/epgp/ledger-list";

// Same windows + default as the roster's "Recently active" filter
// (RosterTable) — the Totals tab is a second roster, so it should default
// to the guild's active players, not everyone who's ever earned a point
// (leader, 2026-09-06).
const ACTIVE_WINDOWS: { key: string; label: string; ms: number | null }[] = [
  { key: "24h", label: "Last 24 hours", ms: 24 * 60 * 60 * 1000 },
  { key: "7d", label: "Last 7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { key: "30d", label: "Last 30 days", ms: 30 * 24 * 60 * 60 * 1000 },
  { key: "90d", label: "Last 90 days", ms: 90 * 24 * 60 * 60 * 1000 },
  { key: "365d", label: "Last year", ms: 365 * 24 * 60 * 60 * 1000 },
  { key: "any", label: "Any time", ms: null },
];
const DEFAULT_ACTIVE_WINDOW = "90d";

// Mirrors the guild sheet's own Totals tab: one row per player (main
// character name — alt/mule activity is already rolled into these numbers,
// see getTotalsRows), last activity, EP, GP, priority.
export function TotalsTable({ rows, searching = false }: { rows: TotalsRow[]; searching?: boolean }) {
  const [activeFilter, setActiveFilter] = useState<string>(DEFAULT_ACTIVE_WINDOW);

  const filtered = useMemo(() => {
    const ms = ACTIVE_WINDOWS.find((w) => w.key === activeFilter)?.ms ?? null;
    if (ms === null) return rows;
    const cutoff = Date.now() - ms;
    return rows.filter((r) => r.lastActivityAt !== null && new Date(r.lastActivityAt).getTime() >= cutoff);
  }, [rows, activeFilter]);

  type Col = "main" | "lastActivity" | "ep" | "epDecay" | "gp" | "gpDecay" | "priority";
  const { sorted, sort, toggle } = useTableSort<TotalsRow, Col>(filtered, {
    main: (r) => r.mainCharacterName,
    lastActivity: (r) => (r.lastActivityAt ? new Date(r.lastActivityAt).getTime() : null),
    ep: (r) => r.ep,
    epDecay: (r) => r.epDecay,
    gp: (r) => r.gp,
    gpDecay: (r) => r.gpDecay,
    priority: (r) => r.priorityRating,
  });

  return (
    <div>
      <div className="mb-3 flex items-end justify-between gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Recently active</span>
          <select value={activeFilter} onChange={(e) => setActiveFilter(e.target.value)} className={fieldClasses({ size: "sm" })}>
            {ACTIVE_WINDOWS.map((w) => (
              <option key={w.key} value={w.key}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
        <span className="pb-1.5 text-xs text-neutral-500">
          {filtered.length} of {rows.length} player{rows.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
              <SortableTh className="px-3 py-2" label="Main" sortKey="main" sort={sort} onSort={toggle} />
              <SortableTh className="px-3 py-2" label="Last activity" sortKey="lastActivity" sort={sort} onSort={toggle} />
              <SortableTh className="px-3 py-2 text-right" label="EP" sortKey="ep" sort={sort} onSort={toggle} />
              <SortableTh className="px-3 py-2 text-right" label="EP Decay" sortKey="epDecay" sort={sort} onSort={toggle} />
              <SortableTh className="px-3 py-2 text-right" label="GP" sortKey="gp" sort={sort} onSort={toggle} />
              <SortableTh className="px-3 py-2 text-right" label="GP Decay" sortKey="gpDecay" sort={sort} onSort={toggle} />
              <SortableTh className="px-3 py-2 text-right" label="Priority" sortKey="priority" sort={sort} onSort={toggle} />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sorted.map((r) => (
              <tr key={r.playerId} className="hover:bg-neutral-900/40">
                <td className="px-3 py-2 font-medium">
                  {r.mainCharacterName}
                  {r.playerStatus !== "active" && (
                    <span className="ml-2 rounded-full bg-neutral-700/40 px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-400">
                      {r.playerStatus}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-neutral-400">{r.lastActivityAt ? guildDate(r.lastActivityAt) : "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">{Math.round(r.ep)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-neutral-500">{r.epDecay > 0 ? `-${Math.round(r.epDecay)}` : "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">{Math.round(r.gp)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-neutral-500">{r.gpDecay > 0 ? `-${Math.round(r.gpDecay)}` : "—"}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-emerald-400">{r.priorityRating.toFixed(4)}</td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-neutral-500">
                  {searching
                    ? "No players match that search."
                    : rows.length === 0
                      ? "No players with a resolved main character yet."
                      : "No players active in that window — widen “Recently active”."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
