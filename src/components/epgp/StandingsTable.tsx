"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { fieldClasses } from "@/components/ui/Field";
import { CHAR_CLASSES } from "@/lib/eq/enums";

export type StandingsRow = {
  id: number;
  name: string;
  classId: number;
  className: string;
  level: number;
  charType: "main" | "alt";
  ownerUsername: string | null;
  ep: number;
  gp: number;
  priorityRating: number;
};

type SortKey = "name" | "className" | "level" | "ep" | "gp" | "priorityRating";
type SortDir = "asc" | "desc";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "className", label: "Class" },
  { key: "level", label: "Level" },
  { key: "ep", label: "EP" },
  { key: "gp", label: "GP" },
  { key: "priorityRating", label: "Priority" },
];

function compare(a: StandingsRow, b: StandingsRow, key: SortKey): number {
  const av = a[key];
  const bv = b[key];
  if (typeof av === "number" && typeof bv === "number") return av - bv;
  return String(av).localeCompare(String(bv));
}

// This site's roster mirror (§9 in the EPGP plan) — like RosterTable, loads
// the whole standings set client-side rather than paginating: 257
// characters today is the same order of magnitude as /roster already
// handles unfiltered. The ledger browser (paginated) is where row count
// actually gets large.
export function StandingsTable({ rows }: { rows: StandingsRow[] }) {
  const [search, setSearch] = useState("");
  const [classFilter, setClassFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("priorityRating");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !r.name.toLowerCase().includes(q) && !(r.ownerUsername ?? "").toLowerCase().includes(q)) return false;
      if (classFilter !== "all" && String(r.classId) !== classFilter) return false;
      if (typeFilter !== "all" && r.charType !== typeFilter) return false;
      return true;
    });
  }, [rows, search, classFilter, typeFilter]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => compare(a, b, sortKey) * (sortDir === "asc" ? 1 : -1));
    return copy;
  }, [filtered, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" || key === "className" ? "asc" : "desc");
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Search</span>
          <input
            type="text"
            placeholder="Character or owner…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={`${fieldClasses({ size: "sm" })} w-48`}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Class</span>
          <select value={classFilter} onChange={(e) => setClassFilter(e.target.value)} className={fieldClasses({ size: "sm" })}>
            <option value="all">All classes</option>
            {CHAR_CLASSES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Type</span>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className={fieldClasses({ size: "sm" })}>
            <option value="all">Mains &amp; alts</option>
            <option value="main">Mains only</option>
            <option value="alt">Alts only</option>
          </select>
        </label>

        <span className="pb-1.5 text-sm text-neutral-500">
          {sorted.length} of {rows.length} character{rows.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="mt-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
              {COLUMNS.map((col) => (
                <th key={col.key} className="px-3 py-2 font-medium">
                  <button type="button" onClick={() => toggleSort(col.key)} className="flex items-center gap-1 hover:text-neutral-200">
                    {col.label}
                    {sortKey === col.key && <span className="text-neutral-400">{sortDir === "asc" ? "▲" : "▼"}</span>}
                  </button>
                </th>
              ))}
              <th className="px-3 py-2 font-medium">Owner</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sorted.map((r) => (
              <tr key={r.id} className="hover:bg-neutral-900/40">
                <td className="px-3 py-2 font-medium">
                  <Link href={`/characters/${r.id}`} className="hover:text-emerald-400">
                    {r.name}
                  </Link>
                  {r.charType === "alt" && <span className="ml-1.5 text-xs font-normal text-neutral-500">(Alt)</span>}
                </td>
                <td className="px-3 py-2 text-neutral-400">{r.className}</td>
                <td className="px-3 py-2 text-neutral-400">{r.level}</td>
                <td className="px-3 py-2 text-neutral-400">{r.ep.toFixed(1)}</td>
                <td className="px-3 py-2 text-neutral-400">{r.gp.toFixed(1)}</td>
                <td className="px-3 py-2 font-medium text-emerald-400">{r.priorityRating.toFixed(2)}</td>
                <td className="px-3 py-2 text-neutral-500">{r.ownerUsername ?? "(unclaimed)"}</td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length + 1} className="px-3 py-6 text-center text-neutral-500">
                  No characters match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
