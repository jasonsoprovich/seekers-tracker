"use client";

import Link from "next/link";
import { Fragment, useMemo, useState } from "react";

import { DeleteCharacterButton } from "@/components/DeleteCharacterButton";
import { RoleSelect } from "@/components/RoleSelect";
import { fieldClasses } from "@/components/ui/Field";
import { CharacterStatusBadge } from "@/components/ui/CharacterStatusBadge";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { RoleBadge } from "@/components/ui/RoleBadge";
import type { Role } from "@/lib/authz";
import { characterStatusLabel, type CharacterStatus } from "@/lib/character-status";
import { CHAR_CLASSES, CHAR_RACES } from "@/lib/eq/enums";

export type AdminCharacterRow = {
  id: number;
  name: string;
  classId: number;
  className: string;
  raceId: number;
  raceName: string;
  level: number;
  charType: "main" | "alt" | "mule";
  status: CharacterStatus;
  mainCharacterId: number | null;
  mainName: string | null;
  ownerUsername: string | null;
  ownerId: string | null;
  ownerRole: Role | null;
  popDone: number;
  popTotal: number;
};

// Same search/filter set as RosterTable, so admins can find a character here
// the same way they'd look it up on /roster.
export function AdminCharacterList({
  rows,
  canEditRoles,
  selfUserId,
}: {
  rows: AdminCharacterRow[];
  canEditRoles: boolean;
  selfUserId: string;
}) {
  const [search, setSearch] = useState("");
  const [classFilter, setClassFilter] = useState<string>("all");
  const [raceFilter, setRaceFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const [minLevel, setMinLevel] = useState("");
  const [maxLevel, setMaxLevel] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    const min = minLevel === "" ? null : Number(minLevel);
    const max = maxLevel === "" ? null : Number(maxLevel);

    return (r: AdminCharacterRow) => {
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

  // Alts nest under their main so they stay visually grouped instead of
  // interleaving with everyone else's — same tree as RosterTable's.
  type Group = { main: AdminCharacterRow; alts: AdminCharacterRow[] };
  const groups = useMemo(() => {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const groupMap = new Map<number, Group>();
    const orphans: AdminCharacterRow[] = [];

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
    result.sort((a, b) => a.main.name.localeCompare(b.main.name));
    for (const group of result) group.alts.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  }, [groups, matches]);

  const groupsWithAlts = useMemo(() => visibleGroups.filter((g) => g.alts.length > 0), [visibleGroups]);
  const visibleCount = visibleGroups.reduce((n, g) => n + 1 + g.alts.length, 0);

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
            <option value="inactive">{characterStatusLabel("inactive")}</option>
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

      {visibleGroups.length === 0 ? (
        <p className="mt-4 text-neutral-400">No characters match these filters.</p>
      ) : (
        <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
          {visibleGroups.map((group) => {
            const hasAlts = group.alts.length > 0;
            const isOpen = hasAlts && (expanded.has(group.main.id) || !matches(group.main));
            return (
              <Fragment key={group.main.id}>
                {renderCard(group.main, hasAlts ? { open: isOpen, onClick: () => toggleExpanded(group.main.id) } : undefined)}
                {hasAlts && isOpen && group.alts.map((alt) => renderCard(alt))}
              </Fragment>
            );
          })}
        </ul>
      )}
    </div>
  );

  function renderCard(c: AdminCharacterRow, toggle?: { open: boolean; onClick: () => void }) {
    return (
      <li key={c.id} className="flex items-center justify-between px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 font-medium">
            <span className="inline-flex items-center gap-1.5">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {toggle && (
                  <button
                    type="button"
                    onClick={toggle.onClick}
                    aria-label={toggle.open ? "Hide alts" : "Show alts"}
                    className="flex h-4 w-4 items-center justify-center text-neutral-500 hover:text-neutral-200"
                  >
                    {toggle.open ? "▾" : "▸"}
                  </button>
                )}
              </span>
              <Link href={`/characters/${c.id}`} className="hover:text-emerald-400">
                {c.name}
              </Link>
            </span>
            <span className="text-sm font-normal text-neutral-500">
              {c.charType === "alt" ? "(Alt)" : "(Main)"} — {c.ownerUsername ?? "(unclaimed)"}
              {c.charType === "alt" && c.mainName && <> → {c.mainName}</>}
            </span>
            <RoleBadge role={c.ownerRole} />
            <CharacterStatusBadge status={c.status} />
          </p>
          <p className="text-sm text-neutral-400">
            Level {c.level} {c.className} — {c.raceName}
          </p>
          <div className="mt-1.5 w-32">
            <ProgressBar done={c.popDone} total={c.popTotal} suffix=" PoP" />
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="flex items-center gap-4">
            <Link href={`/characters/${c.id}/edit`} className="text-sm font-medium text-emerald-400 hover:text-emerald-300">
              Edit
            </Link>
            <DeleteCharacterButton characterId={c.id} characterName={c.name} />
          </div>
          {canEditRoles && c.charType === "main" && c.ownerId && (
            // ownerId is truthy here, so the leftJoin matched a users row —
            // ownerRole can't actually be null in this branch.
            <RoleSelect userId={c.ownerId} role={c.ownerRole!} isSelf={c.ownerId === selfUserId} />
          )}
        </div>
      </li>
    );
  }
}
