"use client";

import { useMemo, useState } from "react";

import { fieldClasses } from "@/components/ui/Field";
import { ledgerDate } from "@/lib/format-date";
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
              <th className="px-3 py-2 font-medium">Main</th>
              <th className="px-3 py-2 font-medium">Last activity</th>
              <th className="px-3 py-2 text-right font-medium">EP</th>
              <th className="px-3 py-2 text-right font-medium">EP Decay</th>
              <th className="px-3 py-2 text-right font-medium">GP</th>
              <th className="px-3 py-2 text-right font-medium">GP Decay</th>
              <th className="px-3 py-2 text-right font-medium">Priority</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filtered.map((r) => (
              <tr key={r.playerId} className="hover:bg-neutral-900/40">
                <td className="px-3 py-2 font-medium">
                  {r.mainCharacterName}
                  {r.playerStatus !== "active" && (
                    <span className="ml-2 rounded-full bg-neutral-700/40 px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-400">
                      {r.playerStatus}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-neutral-400">{r.lastActivityAt ? ledgerDate(r.lastActivityAt) : "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">{Math.round(r.ep)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-neutral-500">{r.epDecay > 0 ? `-${Math.round(r.epDecay)}` : "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">{Math.round(r.gp)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-neutral-500">{r.gpDecay > 0 ? `-${Math.round(r.gpDecay)}` : "—"}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-emerald-400">{r.priorityRating.toFixed(4)}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
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
