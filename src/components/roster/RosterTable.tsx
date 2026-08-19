"use client";

import Link from "next/link";
import { Fragment, useMemo, useState } from "react";

import { CharacterStatusBadge } from "@/components/ui/CharacterStatusBadge";
import { fieldClasses } from "@/components/ui/Field";
import { roleRank, RoleBadge } from "@/components/ui/RoleBadge";
import type { Role } from "@/lib/authz";
import { characterStatusLabel, type CharacterStatus } from "@/lib/character-status";
import { CHAR_CLASSES, CHAR_RACES } from "@/lib/eq/enums";

export type RosterRow = {
  id: number;
  name: string;
  ownerUsername: string | null;
  ownerRole: Role | null;
  isClaimed: boolean;
  classId: number;
  className: string;
  raceId: number;
  level: number;
  charType: "main" | "alt";
  status: CharacterStatus;
  mainCharacterId: number | null;
  // Alts share their main's EP/GP/Priority/decay — see roster/page.tsx.
  ep: number | null;
  gp: number | null;
  // The decay that'll be subtracted from EP/GP at the next cycle's end —
  // see src/lib/epgp/totals.ts.
  epDecay: number | null;
  gpDecay: number | null;
  priorityRating: number | null;
};

type SortKey = "name" | "ownerUsername" | "ownerRole" | "className" | "level" | "charType" | "ep" | "gp" | "priorityRating";
type SortDir = "asc" | "desc";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "ownerUsername", label: "Owner" },
  { key: "ownerRole", label: "Role" },
  { key: "charType", label: "Type" },
  { key: "className", label: "Class" },
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

type Group = { main: RosterRow; alts: RosterRow[] };

export function RosterTable({ rows }: { rows: RosterRow[] }) {
  const [search, setSearch] = useState("");
  const [classFilter, setClassFilter] = useState<string>("all");
  const [raceFilter, setRaceFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const [minLevel, setMinLevel] = useState("");
  const [maxLevel, setMaxLevel] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    const min = minLevel === "" ? null : Number(minLevel);
    const max = maxLevel === "" ? null : Number(maxLevel);

    return (r: RosterRow) => {
      if (q && !r.name.toLowerCase().includes(q) && !(r.ownerUsername ?? "").toLowerCase().includes(q)) return false;
      if (classFilter !== "all" && String(r.classId) !== classFilter) return false;
      if (raceFilter !== "all" && String(r.raceId) !== raceFilter) return false;
      if (typeFilter !== "all" && r.charType !== typeFilter) return false;
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (min !== null && r.level < min) return false;
      if (max !== null && r.level > max) return false;
      return true;
    };
  }, [search, classFilter, raceFilter, typeFilter, statusFilter, minLevel, maxLevel]);

  // Alts nest under their main so expand/collapse can show or hide them as a
  // unit; an alt whose main went missing (or wasn't itself a "main" row)
  // stands alone at the top level instead of vanishing.
  const groups = useMemo(() => {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const groupMap = new Map<number, Group>();
    const orphans: RosterRow[] = [];

    for (const r of rows) {
      if (r.charType === "main") groupMap.set(r.id, { main: r, alts: [] });
    }
    for (const r of rows) {
      if (r.charType !== "alt") continue;
      const main = r.mainCharacterId !== null ? byId.get(r.mainCharacterId) : undefined;
      if (main && main.charType === "main" && groupMap.has(main.id)) {
        groupMap.get(main.id)!.alts.push(r);
      } else {
        orphans.push(r);
      }
    }
    return { groupMap, orphans };
  }, [rows]);

  const visibleGroups = useMemo(() => {
    const result: Group[] = [];
    for (const group of groups.groupMap.values()) {
      const alts = group.alts.filter(matches);
      if (matches(group.main) || alts.length > 0) result.push({ main: group.main, alts });
    }
    for (const orphan of groups.orphans) {
      if (matches(orphan)) result.push({ main: orphan, alts: [] });
    }

    result.sort((a, b) => compare(a.main, b.main, sortKey) * (sortDir === "asc" ? 1 : -1));
    for (const group of result) {
      group.alts.sort((a, b) => a.name.localeCompare(b.name));
    }
    return result;
  }, [groups, matches, sortKey, sortDir]);

  const groupsWithAlts = useMemo(() => visibleGroups.filter((g) => g.alts.length > 0), [visibleGroups]);
  const visibleCount = visibleGroups.reduce((n, g) => n + 1 + g.alts.length, 0);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function toggleExpanded(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function expandAll() {
    setExpanded(new Set(groupsWithAlts.map((g) => g.main.id)));
  }
  function collapseAll() {
    setExpanded(new Set());
  }

  function renderRow(r: RosterRow, opts: { toggle?: { open: boolean; onClick: () => void } } = {}) {
    return (
      <tr key={r.id} className="hover:bg-neutral-900/40">
        <td className="px-3 py-2 font-medium">
          <span className="inline-flex items-center gap-1.5">
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              {opts.toggle && (
                <button
                  type="button"
                  onClick={opts.toggle.onClick}
                  aria-label={opts.toggle.open ? "Hide alts" : "Show alts"}
                  className="flex h-4 w-4 items-center justify-center text-neutral-500 hover:text-neutral-200"
                >
                  {opts.toggle.open ? "▾" : "▸"}
                </button>
              )}
            </span>
            <Link href={`/characters/${r.id}`} className="hover:text-emerald-400">
              {r.name}
            </Link>
            <CharacterStatusBadge status={r.status} />
          </span>
        </td>
        <td className="px-3 py-2 text-neutral-400">{r.ownerUsername ?? "N/A"}</td>
        <td className="px-3 py-2">
          <RoleBadge role={r.ownerRole ?? "member"} />
        </td>
        <td className="px-3 py-2 text-neutral-400">{r.charType === "main" ? "Main" : "Alt"}</td>
        <td className="px-3 py-2 text-neutral-400">{r.className}</td>
        <td className="px-3 py-2 text-neutral-400">{r.level}</td>
        {/* EP/GP are already net of decay — the ready-to-use number — with the
            upcoming decay shown small underneath for context, not as its own
            column competing for attention. Priority stays the one clearly
            "important" number alongside these. */}
        <td className="px-3 py-2">
          <div className="font-medium text-neutral-200">{r.ep === null ? "—" : Math.round(r.ep)}</div>
          {!!r.epDecay && <div className="text-xs text-neutral-600">-{Math.round(r.epDecay)} next decay</div>}
        </td>
        <td className="px-3 py-2">
          <div className="font-medium text-neutral-200">{r.gp === null ? "—" : Math.round(r.gp)}</div>
          {!!r.gpDecay && <div className="text-xs text-neutral-600">-{Math.round(r.gpDecay)} next decay</div>}
        </td>
        <td className="px-3 py-2 font-semibold text-emerald-400">{r.priorityRating?.toFixed(2) ?? "—"}</td>
        <td className="px-3 py-2 text-center">{r.isClaimed && <span className="text-emerald-400">✓</span>}</td>
      </tr>
    );
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
          <span className="text-neutral-400">Status</span>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={fieldClasses({ size: "sm" })}>
            <option value="active">Active only</option>
            <option value="all">All statuses</option>
            <option value="retired">{characterStatusLabel("retired")}</option>
            <option value="removed">{characterStatusLabel("removed")}</option>
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

        <div className="flex gap-2 pb-0.5">
          <button
            type="button"
            onClick={expandAll}
            disabled={groupsWithAlts.length === 0}
            className="rounded-md border border-field px-2.5 py-1 text-sm font-medium text-neutral-300 hover:bg-neutral-900/60 disabled:opacity-40"
          >
            Show alts
          </button>
          <button
            type="button"
            onClick={collapseAll}
            disabled={expanded.size === 0}
            className="rounded-md border border-field px-2.5 py-1 text-sm font-medium text-neutral-300 hover:bg-neutral-900/60 disabled:opacity-40"
          >
            Hide alts
          </button>
        </div>

        <span className="pb-1.5 text-sm text-neutral-500">
          {visibleCount} of {rows.length} character{rows.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="mt-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[760px] text-left text-sm">
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
              <th className="px-3 py-2 text-center font-medium">Claimed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visibleGroups.map((group) => {
              const hasAlts = group.alts.length > 0;
              const isOpen = hasAlts && (expanded.has(group.main.id) || !matches(group.main));
              return (
                <Fragment key={group.main.id}>
                  {renderRow(group.main, hasAlts ? { toggle: { open: isOpen, onClick: () => toggleExpanded(group.main.id) } } : {})}
                  {hasAlts && isOpen && group.alts.map((alt) => renderRow(alt))}
                </Fragment>
              );
            })}
            {visibleGroups.length === 0 && (
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
