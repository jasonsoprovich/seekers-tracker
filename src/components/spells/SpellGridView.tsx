"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { setCharacterSpell } from "@/app/(app)/characters/[id]/spells/actions";
import { setSpellHidden } from "@/app/(app)/spells/actions";
import { CharacterStatusBadge } from "@/components/ui/CharacterStatusBadge";
import { fieldClasses } from "@/components/ui/Field";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { characterStatusLabel, type CharacterStatus } from "@/lib/character-status";
import { ACTIVITY_WINDOWS, DEFAULT_WINDOW } from "@/lib/dashboard-window";
import { CHAR_CLASSES, classColor } from "@/lib/eq/enums";
import { SPELL_CLASS_IDS, SPELL_LEVELS, spellsForClass, type ClassSpell } from "@/lib/spells";

export interface SpellGridRow {
  id: number;
  name: string;
  ownerUsername: string;
  classId: number;
  charType: "main" | "alt";
  status: CharacterStatus;
  departed: boolean;
  lastActivityAt: number | null;
  owned: number[];
  // Newest character_spells.updated_at for this character, and its source.
  updatedAt: number | null;
  updatedSource: string | null;
}

const DAY = 24 * 60 * 60 * 1000;
const STALE_MS = 30 * DAY;

type SortKey = "name" | "have";

const CLASS_STORAGE_KEY = "spells_class";
const ORDER_STORAGE_KEY = "spells_column_order";

function ago(ms: number, nowMs: number): string {
  const d = Math.floor((nowMs - ms) / DAY);
  if (d < 1) return "today";
  if (d < 14) return `${d}d ago`;
  if (d < 60) return `${Math.floor(d / 7)}w ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3 w-3">
      <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5Z" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
      {off && <path d="M2 14 14 2" stroke="currentColor" strokeWidth="1.5" />}
    </svg>
  );
}

export function SpellGridView({
  rows,
  hiddenIds,
  defaultClassId,
  canEdit,
  canHide,
  nowMs,
}: {
  rows: SpellGridRow[];
  hiddenIds: number[];
  defaultClassId: number | null;
  canEdit: boolean;
  canHide: boolean;
  nowMs: number;
}) {
  const [classId, setClassId] = useState<number>(
    defaultClassId !== null && SPELL_CLASS_IDS.includes(defaultClassId) ? defaultClassId : SPELL_CLASS_IDS[0]!,
  );
  const [order, setOrder] = useState<"level" | "name">("level");
  const [typeFilter, setTypeFilter] = useState<"main" | "all">("main");
  const [statusFilter, setStatusFilter] = useState("active");
  const [activityFilter, setActivityFilter] = useState<string>(DEFAULT_WINDOW);
  const [staleOnly, setStaleOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [editMode, setEditMode] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [hidden, setHidden] = useState(() => new Set(hiddenIds));
  // Optimistic cell edits: "charId:spellId" -> has.
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // A class picked earlier in this browser wins over the viewer's main's.
  useEffect(() => {
    const saved = Number(readStorage(CLASS_STORAGE_KEY));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- browser storage is only readable after mount
    if (readStorage(CLASS_STORAGE_KEY) !== null && SPELL_CLASS_IDS.includes(saved)) setClassId(saved);
    if (readStorage(ORDER_STORAGE_KEY) === "name") setOrder("name");
  }, []);

  function pickClass(id: number) {
    setClassId(id);
    writeStorage(CLASS_STORAGE_KEY, String(id));
  }

  function pickOrder(v: string) {
    const next = v === "name" ? "name" : "level";
    setOrder(next);
    writeStorage(ORDER_STORAGE_KEY, next);
  }

  const ownedSets = useMemo(() => new Map(rows.map((r) => [r.id, new Set(r.owned)])), [rows]);

  const has = useCallback(
    (charId: number, spellId: number): boolean => {
      const o = overrides.get(`${charId}:${spellId}`);
      return o ?? ownedSets.get(charId)?.has(spellId) ?? false;
    },
    [overrides, ownedSets],
  );

  // Rows that pass every filter except class — the class pills summarize these.
  const baseRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const windowMs = ACTIVITY_WINDOWS.find((w) => w.value === activityFilter)?.ms ?? Infinity;
    const cutoff = windowMs === Infinity ? null : nowMs - windowMs;
    return rows.filter((r) => {
      if (q && !r.name.toLowerCase().includes(q) && !r.ownerUsername.toLowerCase().includes(q)) return false;
      if (typeFilter === "main" && r.charType !== "main") return false;
      const status = r.departed ? "removed" : r.status;
      if (statusFilter !== "all" && status !== statusFilter) return false;
      if (cutoff !== null && (r.lastActivityAt === null || r.lastActivityAt < cutoff)) return false;
      if (staleOnly && r.updatedAt !== null && nowMs - r.updatedAt < STALE_MS) return false;
      return true;
    });
  }, [rows, search, typeFilter, statusFilter, activityFilter, staleOnly, nowMs]);

  const classSpells = useMemo(() => spellsForClass(classId), [classId]);
  const countedSpells = useMemo(() => classSpells.filter((s) => !hidden.has(s.spellId)), [classSpells, hidden]);
  const columns = useMemo(() => {
    const list = showHidden && canHide ? classSpells : countedSpells;
    return order === "name" ? [...list].sort((a, b) => a.name.localeCompare(b.name)) : list;
  }, [classSpells, countedSpells, showHidden, canHide, order]);

  const classRows = useMemo(() => {
    const list = baseRows.filter((r) => r.classId === classId);
    const haveCount = (r: SpellGridRow) => countedSpells.filter((s) => has(r.id, s.spellId)).length;
    list.sort((a, b) => {
      const cmp = sortKey === "have" ? haveCount(a) - haveCount(b) || a.name.localeCompare(b.name) : a.name.localeCompare(b.name);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [baseRows, classId, countedSpells, sortKey, sortDir, has]);

  const classSummary = useMemo(
    () =>
      SPELL_CLASS_IDS.map((id) => {
        const spells = spellsForClass(id).filter((s) => !hidden.has(s.spellId));
        const members = baseRows.filter((r) => r.classId === id);
        const total = spells.length * members.length;
        let done = 0;
        for (const r of members) for (const s of spells) if (has(r.id, s.spellId)) done++;
        return { id, members: members.length, pct: total === 0 ? null : Math.round((done / total) * 100) };
      }),
    [baseRows, hidden, has],
  );

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "have" ? "desc" : "asc");
    }
  }

  async function toggleCell(row: SpellGridRow, spell: ClassSpell) {
    if (!editMode || !canEdit) return;
    const key = `${row.id}:${spell.spellId}`;
    if (busy.has(key)) return;
    const next = !has(row.id, spell.spellId);
    setError(null);
    setOverrides((m) => new Map(m).set(key, next));
    setBusy((b) => new Set(b).add(key));
    const result = await setCharacterSpell(row.id, spell.spellId, next).catch(() => ({
      error: "Couldn't save — check your connection and try again.",
    }));
    setBusy((b) => {
      const n = new Set(b);
      n.delete(key);
      return n;
    });
    if (result.error) {
      setOverrides((m) => new Map(m).set(key, !next));
      setError(`${row.name}: ${result.error}`);
    }
  }

  async function toggleHidden(spell: ClassSpell) {
    const next = !hidden.has(spell.spellId);
    setError(null);
    setHidden((h) => {
      const n = new Set(h);
      if (next) n.add(spell.spellId);
      else n.delete(spell.spellId);
      return n;
    });
    const result = await setSpellHidden(spell.spellId, next).catch(() => ({ error: "Couldn't save — check your connection and try again." }));
    if (result.error) {
      setHidden((h) => {
        const n = new Set(h);
        if (next) n.delete(spell.spellId);
        else n.add(spell.spellId);
        return n;
      });
      setError(result.error);
    }
  }

  const levelBands = useMemo(() => {
    if (order !== "level") return null;
    return SPELL_LEVELS.map((level) => ({ level, span: columns.filter((s) => s.level === level).length })).filter((b) => b.span > 0);
  }, [columns, order]);

  const hiddenInClass = classSpells.length - countedSpells.length;

  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {classSummary.map((c) => {
          const meta = CHAR_CLASSES.find((k) => k.id === c.id)!;
          const active = c.id === classId;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => pickClass(c.id)}
              title={`${meta.name} — ${c.members} character${c.members === 1 ? "" : "s"}`}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                active ? "border-neutral-500 bg-neutral-800 text-neutral-100" : "border-border text-neutral-400 hover:text-neutral-200"
              }`}
            >
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: classColor(c.id) }} />
              {meta.abbr}
              <span className="tabular-nums text-neutral-500">{c.pct === null ? "–" : `${c.pct}%`}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Search</span>
          <input
            type="text"
            placeholder="Name or owner…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={`${fieldClasses({ size: "sm" })} w-44`}
          />
        </label>
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Characters</span>
          <SegmentedToggle
            value={typeFilter}
            onChange={(v) => setTypeFilter(v === "all" ? "all" : "main")}
            options={[
              { value: "main", label: "Mains" },
              { value: "all", label: "Mains + alts" },
            ]}
          />
        </div>
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
          <span className="text-neutral-400">Recently active</span>
          <select
            value={activityFilter}
            onChange={(e) => setActivityFilter(e.target.value)}
            className={fieldClasses({ size: "sm" })}
          >
            {ACTIVITY_WINDOWS.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Columns</span>
          <SegmentedToggle
            value={order}
            onChange={pickOrder}
            options={[
              { value: "level", label: "By level" },
              { value: "name", label: "A–Z" },
            ]}
          />
        </div>
        <label className="flex items-center gap-2 pb-1.5 text-sm text-neutral-300">
          <input type="checkbox" checked={staleOnly} onChange={(e) => setStaleOnly(e.target.checked)} />
          Stale (&gt;30d)
        </label>
        {canHide && hiddenInClass > 0 && (
          <label className="flex items-center gap-2 pb-1.5 text-sm text-neutral-300">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
            Show hidden ({hiddenInClass})
          </label>
        )}
        {canEdit && (
          <button
            type="button"
            onClick={() => setEditMode((e) => !e)}
            className={`mb-0.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              editMode ? "border-amber-500 bg-amber-500/15 text-amber-300" : "border-field text-neutral-400 hover:text-neutral-200"
            }`}
          >
            {editMode ? "Editing — click cells" : "Edit mode"}
          </button>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

      <div className="mt-4 overflow-x-auto rounded-lg border border-border">
        <table className="border-collapse text-left text-sm">
          <thead>
            {levelBands && (
              <tr className="border-b border-border bg-neutral-900/60 text-[10px] tracking-wide text-neutral-500 uppercase">
                <th colSpan={2} className="sticky left-0 z-10 bg-neutral-900" />
                {levelBands.map((b) => (
                  <th key={b.level} colSpan={b.span} className="border-l border-border px-1 py-1 text-center font-medium">
                    {b.level}
                  </th>
                ))}
              </tr>
            )}
            <tr className="border-b border-border bg-neutral-900/60 text-[10px] tracking-wide text-neutral-500 uppercase">
              <th className="sticky left-0 z-10 bg-neutral-900 px-3 py-1.5 align-bottom font-medium whitespace-nowrap">
                <button type="button" onClick={() => toggleSort("name")} className="flex items-center gap-1 hover:text-neutral-200">
                  Character
                  {sortKey === "name" && <span className="text-neutral-400">{sortDir === "asc" ? "▲" : "▼"}</span>}
                </button>
              </th>
              <th className="px-2 py-1.5 align-bottom font-medium whitespace-nowrap">
                <button type="button" onClick={() => toggleSort("have")} className="flex items-center gap-1 hover:text-neutral-200">
                  Have
                  {sortKey === "have" && <span className="text-neutral-400">{sortDir === "asc" ? "▲" : "▼"}</span>}
                </button>
              </th>
              {columns.map((s, i) => {
                const isHidden = hidden.has(s.spellId);
                const count = classRows.filter((r) => has(r.id, s.spellId)).length;
                const bandStart = order === "level" && (i === 0 || columns[i - 1]!.level !== s.level);
                return (
                  <th
                    key={s.spellId}
                    className={`px-0.5 pt-1.5 pb-1 align-bottom font-medium normal-case ${bandStart ? "border-l border-border" : ""} ${
                      isHidden ? "opacity-40" : ""
                    }`}
                  >
                    <div className="flex flex-col items-center gap-1">
                      <span
                        title={`${s.name} (level ${s.level})`}
                        className="max-h-36 overflow-hidden text-[11px] tracking-normal whitespace-nowrap text-neutral-300 [writing-mode:vertical-rl] rotate-180"
                      >
                        {s.name}
                      </span>
                      <span className="text-[9px] tabular-nums text-neutral-500">
                        {count}/{classRows.length}
                      </span>
                      {canHide && (
                        <button
                          type="button"
                          onClick={() => toggleHidden(s)}
                          title={isHidden ? "Show this spell guild-wide" : "Hide this spell guild-wide (stops counting as missing)"}
                          className="text-neutral-600 hover:text-neutral-200"
                        >
                          <EyeIcon off={isHidden} />
                        </button>
                      )}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {classRows.map((r) => {
              const haveCount = countedSpells.filter((s) => has(r.id, s.spellId)).length;
              const stale = r.updatedAt === null || nowMs - r.updatedAt >= STALE_MS;
              return (
                <tr key={r.id} className="hover:bg-neutral-900/40">
                  <td className="sticky left-0 z-10 bg-neutral-950 px-3 py-1.5 whitespace-nowrap">
                    <Link href={`/characters/${r.id}/spells`} prefetch={false} className="font-medium hover:text-emerald-400">
                      {r.name}
                    </Link>
                    <div className="text-[10px] leading-tight text-neutral-500">
                      {r.charType === "main" ? "Main" : "Alt"} <CharacterStatusBadge status={r.departed ? "removed" : r.status} />
                      <span className={stale ? "text-amber-500/70" : ""}>
                        {" · "}
                        {r.updatedAt === null ? "never updated" : `updated ${ago(r.updatedAt, nowMs)}${r.updatedSource === "zeal" ? " · zeal" : ""}`}
                      </span>
                    </div>
                  </td>
                  <td className="px-2 py-1.5 text-xs whitespace-nowrap tabular-nums text-neutral-400">
                    {haveCount}/{countedSpells.length}
                  </td>
                  {columns.map((s, i) => {
                    const yes = has(r.id, s.spellId);
                    const bandStart = order === "level" && (i === 0 || columns[i - 1]!.level !== s.level);
                    const key = `${r.id}:${s.spellId}`;
                    return (
                      <td key={s.spellId} className={`px-0.5 py-1 text-center ${bandStart ? "border-l border-border" : ""}`}>
                        <button
                          type="button"
                          disabled={!editMode || busy.has(key)}
                          onClick={() => toggleCell(r, s)}
                          title={`${r.name} — ${s.name}: ${yes ? "has it" : "missing"}`}
                          className={`mx-auto flex h-5 w-5 items-center justify-center rounded-sm text-[11px] leading-none ${
                            yes ? "bg-emerald-500/80 text-black" : "bg-neutral-800 text-neutral-600"
                          } ${editMode ? "cursor-pointer ring-amber-400/60 hover:ring-1" : "cursor-default"} ${
                            hidden.has(s.spellId) ? "opacity-40" : ""
                          }`}
                        >
                          {yes ? "✓" : "✗"}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {classRows.length === 0 && (
              <tr>
                <td colSpan={2 + columns.length} className="px-3 py-6 text-center text-neutral-500">
                  No characters match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-neutral-500">
        Counts on each column are how many of the characters shown have it. Members update their own from each
        character&apos;s Spells tab (check off or import a Zeal spellbook).
        {canHide && " Hidden spells don't count as missing anywhere."}
      </p>
    </div>
  );
}
