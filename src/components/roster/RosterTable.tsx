"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { fieldClasses } from "@/components/ui/Field";
import { roleRank, RoleBadge } from "@/components/ui/RoleBadge";
import type { Role } from "@/lib/authz";
import { CHAR_CLASSES, CHAR_RACES } from "@/lib/eq/enums";

export type RosterRow = {
  id: number;
  name: string;
  ownerUsername: string;
  ownerRole: Role;
  classId: number;
  className: string;
  raceId: number;
  raceName: string;
  level: number;
  charType: "main" | "alt";
  ep: number | null;
  gp: number | null;
  priorityRating: number | null;
};

type SortKey =
  | "name"
  | "ownerUsername"
  | "ownerRole"
  | "className"
  | "raceName"
  | "level"
  | "charType"
  | "ep"
  | "gp"
  | "priorityRating";
type SortDir = "asc" | "desc";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "ownerUsername", label: "Owner" },
  { key: "ownerRole", label: "Role" },
  { key: "charType", label: "Type" },
  { key: "className", label: "Class" },
  { key: "raceName", label: "Race" },
  { key: "level", label: "Level" },
  { key: "ep", label: "EP" },
  { key: "gp", label: "GP" },
  { key: "priorityRating", label: "Priority" },
];

function compare(a: RosterRow, b: RosterRow, key: SortKey): number {
  if (key === "ownerRole") return roleRank(a.ownerRole) - roleRank(b.ownerRole);
  const av = a[key];
  const bv = b[key];
  if (av === null && bv === null) return 0;
  if (av === null) return -1;
  if (bv === null) return 1;
  if (typeof av === "number" && typeof bv === "number") return av - bv;
  return String(av).localeCompare(String(bv));
}

export function RosterTable({ rows }: { rows: RosterRow[] }) {
  const [search, setSearch] = useState("");
  const [classFilter, setClassFilter] = useState<string>("all");
  const [raceFilter, setRaceFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [minLevel, setMinLevel] = useState("");
  const [maxLevel, setMaxLevel] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const min = minLevel === "" ? null : Number(minLevel);
    const max = maxLevel === "" ? null : Number(maxLevel);

    return rows.filter((r) => {
      if (q && !r.name.toLowerCase().includes(q) && !r.ownerUsername.toLowerCase().includes(q)) return false;
      if (classFilter !== "all" && String(r.classId) !== classFilter) return false;
      if (raceFilter !== "all" && String(r.raceId) !== raceFilter) return false;
      if (typeFilter !== "all" && r.charType !== typeFilter) return false;
      if (min !== null && r.level < min) return false;
      if (max !== null && r.level > max) return false;
      return true;
    });
  }, [rows, search, classFilter, raceFilter, typeFilter, minLevel, maxLevel]);

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
      setSortDir("asc");
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Search</span>
          <input
            type="text"
            placeholder="Name or owner…"
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
          <span className="text-neutral-400">Race</span>
          <select value={raceFilter} onChange={(e) => setRaceFilter(e.target.value)} className={fieldClasses({ size: "sm" })}>
            <option value="all">All races</option>
            {CHAR_RACES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
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

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Min level</span>
          <input
            type="number"
            min={1}
            max={60}
            value={minLevel}
            onChange={(e) => setMinLevel(e.target.value)}
            className={`${fieldClasses({ size: "sm" })} w-20`}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Max level</span>
          <input
            type="number"
            min={1}
            max={60}
            value={maxLevel}
            onChange={(e) => setMaxLevel(e.target.value)}
            className={`${fieldClasses({ size: "sm" })} w-20`}
          />
        </label>

        <span className="pb-1.5 text-sm text-neutral-500">
          {sorted.length} of {rows.length} character{rows.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="mt-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
              {COLUMNS.map((col) => (
                <th key={col.key} className="px-3 py-2 font-medium">
                  <button
                    type="button"
                    onClick={() => toggleSort(col.key)}
                    className="flex items-center gap-1 hover:text-neutral-200"
                  >
                    {col.label}
                    {sortKey === col.key && <span className="text-neutral-400">{sortDir === "asc" ? "▲" : "▼"}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sorted.map((r) => (
              <tr key={r.id} className="hover:bg-neutral-900/40">
                <td className="px-3 py-2 font-medium">
                  <Link href={`/characters/${r.id}`} className="hover:text-emerald-400">
                    {r.name}
                  </Link>
                </td>
                <td className="px-3 py-2 text-neutral-400">{r.ownerUsername}</td>
                <td className="px-3 py-2">
                  <RoleBadge role={r.ownerRole} />
                </td>
                <td className="px-3 py-2 text-neutral-400">{r.charType === "main" ? "Main" : "Alt"}</td>
                <td className="px-3 py-2 text-neutral-400">{r.className}</td>
                <td className="px-3 py-2 text-neutral-400">{r.raceName}</td>
                <td className="px-3 py-2 text-neutral-400">{r.level}</td>
                <td className="px-3 py-2 text-neutral-400">{r.ep ?? "—"}</td>
                <td className="px-3 py-2 text-neutral-400">{r.gp ?? "—"}</td>
                <td className="px-3 py-2 text-neutral-400">{r.priorityRating?.toFixed(2) ?? "—"}</td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length} className="px-3 py-6 text-center text-neutral-500">
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
