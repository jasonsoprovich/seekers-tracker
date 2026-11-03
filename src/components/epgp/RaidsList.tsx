"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { fieldClasses } from "@/components/ui/Field";
import { SortableTh, useTableSort } from "@/components/ui/table-sort";
import { raidDisplayName } from "@/lib/epgp/raid-display";
import type { RaidListRow } from "@/lib/epgp/raids";

type Col = "date" | "name" | "leader" | "zones" | "attended" | "items" | "ep" | "gp";

// Same step as the Progression list's Show more. listRaids already returns
// every night (a few hundred rows at most), so search/filter/limit all run
// client-side over that one fetch — no server pagination needed here.
const PAGE_SIZE = 50;

// Client wrapper so the Raids and Events History list columns are click-to-sort
// (LT-19). Default order is whatever listRaids returns (newest night first).
export function RaidsList({ rows }: { rows: RaidListRow[] }) {
  const [query, setQuery] = useState("");
  const [zone, setZone] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);

  const zoneOptions = useMemo(() => [...new Set(rows.flatMap((r) => r.zones))].sort((a, b) => a.localeCompare(b)), [rows]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (zone && !r.zones.includes(zone)) return false;
      // raidDate is YYYY-MM-DD, so string comparison is date comparison.
      if (from && r.raidDate < from) return false;
      if (to && r.raidDate > to) return false;
      if (!term) return true;
      return [r.raidDate, raidDisplayName(r.name, r.zones), r.eventName, r.leader, r.note, ...r.zones].some((v) => v?.toLowerCase().includes(term));
    });
  }, [rows, query, zone, from, to]);

  const { sorted, sort, toggle } = useTableSort<RaidListRow, Col>(filtered, {
    date: (r) => r.raidDate,
    name: (r) => raidDisplayName(r.name, r.zones),
    leader: (r) => r.leader,
    zones: (r) => r.zones.join(", "),
    attended: (r) => r.memberCount,
    items: (r) => r.itemCount,
    ep: (r) => r.epAwarded,
    gp: (r) => r.gpSpent,
  });

  const visible = sorted.slice(0, limit);
  const hasFilters = Boolean(query || zone || from || to);

  // Any filter change starts the list back at the first page.
  function update(set: (v: string) => void) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      set(e.target.value);
      setLimit(PAGE_SIZE);
    };
  }

  function clearFilters() {
    setQuery("");
    setZone("");
    setFrom("");
    setTo("");
    setLimit(PAGE_SIZE);
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Search</span>
          <input type="text" value={query} onChange={update(setQuery)} placeholder="Name, zone, leader, date…" className={`${fieldClasses({ size: "sm" })} w-56`} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Zone</span>
          <select value={zone} onChange={update(setZone)} className={`${fieldClasses({ size: "sm" })} max-w-56`}>
            <option value="">All zones</option>
            {zoneOptions.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">From</span>
          <input type="date" value={from} onChange={update(setFrom)} className={fieldClasses({ size: "sm" })} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">To</span>
          <input type="date" value={to} onChange={update(setTo)} className={fieldClasses({ size: "sm" })} />
        </label>
        {hasFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="rounded-md border border-field px-3 py-1.5 text-sm font-medium text-neutral-300 hover:bg-neutral-900/60"
          >
            Clear filters
          </button>
        )}
        <span className="pb-1.5 text-xs text-neutral-500">{hasFilters ? `${sorted.length} of ${rows.length} events` : `${rows.length} events`}</span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border text-[11px] uppercase tracking-wide text-neutral-500">
            <tr>
              <SortableTh className="px-3 py-2" label="Date" sortKey="date" sort={sort} onSort={toggle} />
              <SortableTh className="px-3 py-2" label="Name" sortKey="name" sort={sort} onSort={toggle} />
              <SortableTh className="px-3 py-2" label="Raid leader" sortKey="leader" sort={sort} onSort={toggle} />
              <SortableTh className="px-3 py-2" label="Zone(s)" sortKey="zones" sort={sort} onSort={toggle} />
              <SortableTh className="px-3 py-2 text-right" label="Attended" sortKey="attended" sort={sort} onSort={toggle} />
              <SortableTh className="px-3 py-2 text-right" label="Items" sortKey="items" sort={sort} onSort={toggle} />
              <SortableTh className="px-3 py-2 text-right" label="EP awarded" sortKey="ep" sort={sort} onSort={toggle} />
              <SortableTh className="px-3 py-2 text-right" label="GP spent" sortKey="gp" sort={sort} onSort={toggle} />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visible.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-neutral-500">
                  No events match these filters.
                </td>
              </tr>
            )}
            {visible.map((r) => (
              <tr key={`${r.raidDate}:${r.eventName ?? ""}`} className="hover:bg-neutral-900/40">
                <td className="px-3 py-2 whitespace-nowrap">
                  <Link href={`/epgp/raids/${r.raidDate}${r.eventName ? `?name=${encodeURIComponent(r.eventName)}` : ""}`} className="font-medium text-emerald-400 hover:text-emerald-300">
                    {r.raidDate}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  {r.name ?? (r.zones.length ? <span className="text-neutral-400">{raidDisplayName(null, r.zones)}</span> : <span className="text-neutral-600">—</span>)}
                </td>
                <td className="px-3 py-2">{r.leader ?? <span className="text-neutral-600">—</span>}</td>
                <td className="px-3 py-2 text-neutral-400">{r.zones.length ? r.zones.join(", ") : "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.memberCount}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.itemCount}</td>
                <td className="px-3 py-2 text-right tabular-nums">{Math.round(r.epAwarded)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{Math.round(r.gpSpent)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sorted.length > visible.length && (
        <button
          type="button"
          onClick={() => setLimit((l) => l + PAGE_SIZE)}
          className="mt-3 w-full rounded-lg border border-dashed border-border px-4 py-2.5 text-sm font-medium text-neutral-300 hover:border-emerald-500/60 hover:bg-neutral-900/60 hover:text-emerald-300"
        >
          Show more ({sorted.length - visible.length} more)
        </button>
      )}
    </div>
  );
}
