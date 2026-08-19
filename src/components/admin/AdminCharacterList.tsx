"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

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
  charType: "main" | "alt";
  status: CharacterStatus;
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const min = minLevel === "" ? null : Number(minLevel);
    const max = maxLevel === "" ? null : Number(maxLevel);

    return rows.filter((r) => {
      if (q && !r.name.toLowerCase().includes(q) && !(r.ownerUsername ?? "").toLowerCase().includes(q)) return false;
      if (classFilter !== "all" && String(r.classId) !== classFilter) return false;
      if (raceFilter !== "all" && String(r.raceId) !== raceFilter) return false;
      if (typeFilter !== "all" && r.charType !== typeFilter) return false;
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (min !== null && r.level < min) return false;
      if (max !== null && r.level > max) return false;
      return true;
    });
  }, [rows, search, classFilter, raceFilter, typeFilter, statusFilter, minLevel, maxLevel]);

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

        <span className="pb-1.5 text-sm text-neutral-500">
          {filtered.length} of {rows.length} character{rows.length === 1 ? "" : "s"}
        </span>
      </div>

      {filtered.length === 0 ? (
        <p className="mt-4 text-neutral-400">No characters match these filters.</p>
      ) : (
        <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
          {filtered.map((c) => (
            <li key={c.id} className="flex items-center justify-between px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 font-medium">
                  <Link href={`/characters/${c.id}`} className="hover:text-emerald-400">
                    {c.name}
                  </Link>
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
          ))}
        </ul>
      )}
    </div>
  );
}
