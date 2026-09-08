"use client";

import Link from "next/link";

import { SortableTh, useTableSort } from "@/components/ui/table-sort";
import type { RaidListRow } from "@/lib/epgp/raids";

type Col = "date" | "name" | "zones" | "attended" | "items" | "ep" | "gp";

// Client wrapper so the Raids & Events list columns are click-to-sort
// (LT-19). Default order is whatever listRaids returns (newest night first).
export function RaidsList({ rows }: { rows: RaidListRow[] }) {
  const { sorted, sort, toggle } = useTableSort<RaidListRow, Col>(rows, {
    date: (r) => r.raidDate,
    name: (r) => r.name,
    zones: (r) => r.zones.join(", "),
    attended: (r) => r.memberCount,
    items: (r) => r.itemCount,
    ep: (r) => r.epAwarded,
    gp: (r) => r.gpSpent,
  });

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-border text-[11px] uppercase tracking-wide text-neutral-500">
          <tr>
            <SortableTh className="px-3 py-2" label="Date" sortKey="date" sort={sort} onSort={toggle} />
            <SortableTh className="px-3 py-2" label="Name" sortKey="name" sort={sort} onSort={toggle} />
            <SortableTh className="px-3 py-2" label="Zone(s)" sortKey="zones" sort={sort} onSort={toggle} />
            <SortableTh className="px-3 py-2 text-right" label="Attended" sortKey="attended" sort={sort} onSort={toggle} />
            <SortableTh className="px-3 py-2 text-right" label="Items" sortKey="items" sort={sort} onSort={toggle} />
            <SortableTh className="px-3 py-2 text-right" label="EP awarded" sortKey="ep" sort={sort} onSort={toggle} />
            <SortableTh className="px-3 py-2 text-right" label="GP spent" sortKey="gp" sort={sort} onSort={toggle} />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {sorted.map((r) => (
            <tr key={r.raidDate} className="hover:bg-neutral-900/40">
              <td className="px-3 py-2 whitespace-nowrap">
                <Link href={`/epgp/raids/${r.raidDate}`} className="font-medium text-emerald-400 hover:text-emerald-300">
                  {r.raidDate}
                </Link>
              </td>
              <td className="px-3 py-2">{r.name ?? <span className="text-neutral-600">—</span>}</td>
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
  );
}
