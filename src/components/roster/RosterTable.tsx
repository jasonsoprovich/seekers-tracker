"use client";

import Link from "next/link";
import { Fragment, useMemo, useState } from "react";

import { CharacterStatusBadge } from "@/components/ui/CharacterStatusBadge";
import { Button } from "@/components/ui/Button";
import { fieldClasses } from "@/components/ui/Field";
import { MobileCard } from "@/components/ui/MobileCard";
import { roleRank, RoleBadge } from "@/components/ui/RoleBadge";
import type { Role } from "@/lib/authz";
import { characterStatusLabel, type CharacterStatus } from "@/lib/character-status";
import { CHAR_CLASSES, CHAR_RACES } from "@/lib/eq/enums";

// The Class and Race filter dropdowns list alphabetically with "Unknown"
// pinned last (it's a catch-all, not a real class/race). The enums stay in
// their canonical EQ order everywhere else — this ordering is display-only
// for these two <select>s.
const byNameUnknownLast = (a: { name: string }, b: { name: string }) =>
  a.name === "Unknown" ? 1 : b.name === "Unknown" ? -1 : a.name.localeCompare(b.name);
const CLASS_FILTER_OPTIONS = [...CHAR_CLASSES].sort(byNameUnknownLast);
const RACE_FILTER_OPTIONS = [...CHAR_RACES].sort(byNameUnknownLast);

export type RosterRow = {
  id: number;
  name: string;
  hasPendingClaim: boolean;
  // The Account page remains readable by every member, but officers and
  // above get the explicit management action from this directory.
  canManageAccount: boolean;
  ownerUsername: string | null;
  ownerRole: Role | null;
  classId: number;
  className: string;
  raceId: number;
  level: number;
  charType: "main" | "alt" | "mule";
  status: CharacterStatus;
  // The account was removed from the guild (players.status 'departed') —
  // hidden under "Active only", shown under "Removed from guild" / "All".
  departed: boolean;
  playerId: number | null;
  playerMainId: number | null;
  // Alts share their main's EP/GP/Priority/decay — see roster/page.tsx.
  ep: number | null;
  gp: number | null;
  // The decay that'll be subtracted from EP/GP at the next cycle's end —
  // see src/lib/epgp/totals.ts.
  epDecay: number | null;
  gpDecay: number | null;
  priorityRating: number | null;
  // ms epoch of this character's most recent EP/GP entry (shared across a
  // player's group since rows land on the main), or null if never active.
  lastActivityAt: number | null;
};

const ACTIVE_WINDOWS: { key: string; label: string; ms: number | null }[] = [
  { key: "24h", label: "Last 24 hours", ms: 24 * 60 * 60 * 1000 },
  { key: "7d", label: "Last 7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { key: "30d", label: "Last 30 days", ms: 30 * 24 * 60 * 60 * 1000 },
  { key: "90d", label: "Last 90 days", ms: 90 * 24 * 60 * 60 * 1000 },
  { key: "365d", label: "Last year", ms: 365 * 24 * 60 * 60 * 1000 },
  { key: "any", label: "Any time", ms: null },
];

// Default to "Any time" (post-live-test-1 LT-34). Members mostly use this
// page to *look up* a character — who owns it, is it a main or an alt,
// what are its alts — and a windowed default silently drops anyone not
// recently active, so a name search returns nothing with no hint why. The
// "Last 90 days" etc. windows are one click away for browsing the active
// roster.
const DEFAULT_ACTIVE_WINDOW = "any";

const TYPE_LABEL: Record<RosterRow["charType"], string> = { main: "Main", alt: "Alt", mule: "Mule" };

type SortKey = "name" | "ownerUsername" | "ownerRole" | "className" | "level" | "charType" | "ep" | "gp" | "priorityRating";
type SortDir = "asc" | "desc";

// Owner sits last on purpose: it doubles as the old "Claimed" column (a
// name here == claimed, "Unclaimed" == not), so it reads as a trailing
// status rather than a primary identifier.
const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "ownerRole", label: "Role" },
  { key: "charType", label: "Type" },
  { key: "className", label: "Class" },
  { key: "level", label: "Level" },
  { key: "ep", label: "EP" },
  { key: "gp", label: "GP" },
  { key: "priorityRating", label: "Priority" },
  { key: "ownerUsername", label: "Owner" },
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

type Group = { main: RosterRow; children: RosterRow[] };

export function RosterTable({ rows }: { rows: RosterRow[] }) {
  const hasAccountActions = rows.some((row) => row.canManageAccount);
  const [search, setSearch] = useState("");
  const [classFilters, setClassFilters] = useState<Set<number>>(new Set());
  const [raceFilter, setRaceFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const [activeFilter, setActiveFilter] = useState<string>(DEFAULT_ACTIVE_WINDOW);
  const [minLevel, setMinLevel] = useState("");
  const [maxLevel, setMaxLevel] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const q = search.trim().toLowerCase();
  const hasSearch = q !== "";
  const hasFilters =
    hasSearch ||
    classFilters.size > 0 ||
    raceFilter !== "all" ||
    typeFilter !== "all" ||
    statusFilter !== "active" ||
    activeFilter !== DEFAULT_ACTIVE_WINDOW ||
    minLevel !== "" ||
    maxLevel !== "";

  // post-live-test-1 LT-34 — three predicates instead of one so a search
  // can override the "recently active" window and reveal a whole main+alt
  // group on a hit anywhere in it:
  //   matchesFilters — class / race / type / status / level (the "shape"
  //     filters; always applied)
  //   matchesSearch  — name / owner substring (trivially true with no query)
  //   matchesActive  — the recently-active window
  const { matchesFilters, matchesSearch, matchesActive } = useMemo(() => {
    const min = minLevel === "" ? null : Number(minLevel);
    const max = maxLevel === "" ? null : Number(maxLevel);
    const activeMs = ACTIVE_WINDOWS.find((w) => w.key === activeFilter)?.ms ?? null;
    const activeCutoff = activeMs === null ? null : Date.now() - activeMs;
    return {
      matchesFilters: (r: RosterRow) => {
        if (classFilters.size > 0 && !classFilters.has(r.classId)) return false;
        if (raceFilter !== "all" && String(r.raceId) !== raceFilter) return false;
        if (typeFilter !== "all" && r.charType !== typeFilter) return false;
        if (statusFilter === "departed") {
          if (!r.departed) return false;
        } else if (statusFilter === "active") {
          if (r.status !== "active" || r.departed) return false;
        } else if (statusFilter !== "all" && r.status !== statusFilter) return false;
        if (min !== null && r.level < min) return false;
        if (max !== null && r.level > max) return false;
        return true;
      },
      matchesSearch: (r: RosterRow) =>
        q === "" || r.name.toLowerCase().includes(q) || (r.ownerUsername ?? "").toLowerCase().includes(q),
      matchesActive: (r: RosterRow) =>
        activeCutoff === null || (r.lastActivityAt !== null && r.lastActivityAt >= activeCutoff),
    };
  }, [q, classFilters, raceFilter, typeFilter, statusFilter, activeFilter, minLevel, maxLevel]);

  // The full per-row predicate — used only on the NO-search path (and for
  // the auto-expand check). While searching, the active window is dropped
  // and group membership is decided in `visibleGroups` instead.
  const matches = useMemo(
    () => (r: RosterRow) => matchesFilters(r) && matchesSearch(r) && matchesActive(r),
    [matchesFilters, matchesSearch, matchesActive],
  );

  // The player account and its authoritative main pointer define groups.
  // Character-level main pointers are intentionally irrelevant here: mules
  // belong to the account without pretending to be alts.
  const groups = useMemo(() => {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const groupMap = new Map<number, Group>();
    const orphans: RosterRow[] = [];
    const groupedIds = new Set<number>();

    for (const r of rows) {
      if (r.playerId === null || r.playerMainId === null) continue;
      const main = byId.get(r.playerMainId);
      if (main?.playerId === r.playerId && !groupMap.has(main.id)) {
        groupMap.set(main.id, { main, children: [] });
        groupedIds.add(main.id);
      }
    }
    for (const r of rows) {
      if (groupedIds.has(r.id)) continue;
      const group = r.playerMainId === null ? undefined : groupMap.get(r.playerMainId);
      if (!group || r.playerId !== group.main.playerId) continue;
      group.children.push(r);
      groupedIds.add(r.id);
    }
    for (const r of rows) if (!groupedIds.has(r.id)) orphans.push(r);
    return { groupMap, orphans };
  }, [rows]);

  const visibleGroups = useMemo(() => {
    const result: Group[] = [];
    for (const group of groups.groupMap.values()) {
      if (!hasSearch) {
        // No query: per-row filtering, active window included. Group shows
        // if its main passes or any alt does.
        const children = group.children.filter(matches);
        if (matches(group.main) || children.length > 0) result.push({ main: group.main, children });
        continue;
      }
      // LT-34 search mode: the active window is ignored, and a search hit
      // ANYWHERE in the group (main or any alt) reveals the WHOLE group —
      // so "search a main → see its alts" and "search an alt → see the
      // main + its other alts" both work (a member looking a character up
      // to find who it belongs to). The only thing that still hides alts
      // is "Mains only".
      const mainHit = matchesFilters(group.main) && matchesSearch(group.main);
      const childHit = group.children.some((child) => matchesFilters(child) && matchesSearch(child));
      if (!mainHit && !childHit) continue;
      const children = typeFilter === "main" ? [] : group.children.filter(matchesFilters);
      result.push({ main: group.main, children });
    }
    for (const orphan of groups.orphans) {
      const shown = hasSearch ? matchesFilters(orphan) && matchesSearch(orphan) : matches(orphan);
      if (shown) result.push({ main: orphan, children: [] });
    }

    result.sort((a, b) => compare(a.main, b.main, sortKey) * (sortDir === "asc" ? 1 : -1));
    for (const group of result) {
      group.children.sort(
        (a, b) => (a.charType === "alt" ? 0 : a.charType === "mule" ? 1 : 2) - (b.charType === "alt" ? 0 : b.charType === "mule" ? 1 : 2) || a.name.localeCompare(b.name),
      );
    }
    return result;
  }, [groups, matches, matchesFilters, matchesSearch, hasSearch, typeFilter, sortKey, sortDir]);

  const visibleCount = visibleGroups.reduce((n, g) => n + 1 + g.children.length, 0);

  function toggleClass(classId: number) {
    setClassFilters((current) => {
      const next = new Set(current);
      if (next.has(classId)) next.delete(classId);
      else next.add(classId);
      return next;
    });
  }

  function resetFilters() {
    setSearch("");
    setClassFilters(new Set());
    setRaceFilter("all");
    setTypeFilter("all");
    setStatusFilter("active");
    setActiveFilter(DEFAULT_ACTIVE_WINDOW);
    setMinLevel("");
    setMaxLevel("");
  }

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

  function renderRow(r: RosterRow, opts: { nested?: boolean; toggle?: { open: boolean; onClick: () => void } } = {}) {
    // Alts render as a shaded band directly under their main, with a left
    // accent rule and a deeper name indent, so a main's group of alts reads
    // as one visual unit rather than blending into the next main's row.
    const isNested = opts.nested === true;
    return (
      <tr key={r.id} className={isNested ? "bg-neutral-900/40 hover:bg-neutral-900/60" : "hover:bg-neutral-900/40"}>
        <td className={`py-2 font-medium ${isNested ? "border-l-2 border-l-emerald-700/50 pr-3 pl-6" : "px-3"}`}>
          <span className="inline-flex items-center gap-1.5">
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              {opts.toggle ? (
                <button
                  type="button"
                  onClick={opts.toggle.onClick}
                  aria-label={opts.toggle.open ? "Hide account characters" : "Show account characters"}
                  className="flex h-4 w-4 items-center justify-center text-neutral-500 hover:text-neutral-200"
                >
                  {opts.toggle.open ? "▾" : "▸"}
                </button>
              ) : (
                isNested && (
                  <span className="text-neutral-600" aria-hidden="true">
                    ↳
                  </span>
                )
              )}
            </span>
            {/* Remediation plan Phase 0.2 (2026-09-12): no automatic prefetch —
                Roster can render 700+ rows, and every visible row's link
                becoming eligible for Next's viewport-triggered prefetch turns
                a normal scroll into a burst of concurrent authenticated RSC
                requests to /characters/[id]/account, each running the full
                (app) layout + getSession() chain. Suspected contributor to
                the freeze investigation's "prefetch-like account-page burst"
                pattern in Workers Logs. A click still navigates normally —
                this only stops the speculative background fetch. */}
            <Link href={`/characters/${r.id}/account`} prefetch={false} className="hover:text-emerald-400">
              {r.name}
            </Link>
            <CharacterStatusBadge status={r.status} />
            {r.hasPendingClaim && (
              <span className="rounded border border-amber-700 bg-amber-950/40 px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase text-amber-400">
                Claim pending
              </span>
            )}
            {r.departed && (
              <span className="rounded border border-red-800 bg-red-950/40 px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase text-red-400">
                Removed from guild
              </span>
            )}
          </span>
        </td>
        <td className="px-3 py-2">
          {!r.departed && <RoleBadge role={r.ownerRole ?? "member"} />}
        </td>
        <td className="px-3 py-2 text-neutral-400">{TYPE_LABEL[r.charType]}</td>
        <td className="px-3 py-2 text-neutral-400">{r.className}</td>
        <td className="px-3 py-2 text-neutral-400">{r.level}</td>
        <td className="px-3 py-2">
          <div className="font-medium text-neutral-200">{r.ep === null ? "—" : Math.round(r.ep)}</div>
        </td>
        <td className="px-3 py-2">
          <div className="font-medium text-neutral-200">{r.gp === null ? "—" : Math.round(r.gp)}</div>
        </td>
        {/* 4 dp to match the guild sheet's Loot Priority column — the ratio
            clusters tightly, so 2 dp collapsed too many rows to the same
            value to sort by eye. */}
        <td className="px-3 py-2 font-semibold text-emerald-400">{r.priorityRating?.toFixed(4) ?? "—"}</td>
        <td className="px-3 py-2 text-neutral-400">
          {r.ownerUsername ?? <span className="text-neutral-600">Unclaimed</span>}
        </td>
        {r.canManageAccount && (
          <td className="px-3 py-2 text-right">
            <Link
              href={`/characters/${r.id}/account`}
              prefetch={false}
              className="rounded-full border border-field px-2.5 py-1 text-xs font-medium text-neutral-300 hover:border-emerald-500/60 hover:text-emerald-300"
            >
              View / manage account
            </Link>
          </td>
        )}
      </tr>
    );
  }

  // Mobile substitute for renderRow — same data, laid out as an expandable
  // card (MobileCard) instead of table cells. Key stats (EP/GP/priority)
  // stay in the always-visible summary; the rest (role, type, class, level,
  // owner) sits behind the card's own expand toggle. The alt-group
  // show/hide toggle is a separate small button in the summary, same as
  // renderRow's — expanding the card and revealing its alts are
  // independent actions, not one combined toggle.
  function renderCard(r: RosterRow, opts: { nested?: boolean; toggle?: { open: boolean; onClick: () => void } } = {}) {
    const isNested = opts.nested === true;
    const summary = (
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {opts.toggle ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              opts.toggle!.onClick();
            }}
            aria-label={opts.toggle.open ? "Hide account characters" : "Show account characters"}
            className="flex h-8 w-8 shrink-0 items-center justify-center text-neutral-500 hover:text-neutral-200"
          >
            {opts.toggle.open ? "▾" : "▸"}
          </button>
        ) : (
          isNested && (
            <span className="w-8 shrink-0 text-center text-neutral-600" aria-hidden="true">
              ↳
            </span>
          )
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Link
              href={`/characters/${r.id}/account`}
              prefetch={false}
              onClick={(e) => e.stopPropagation()}
              className="font-medium hover:text-emerald-400"
            >
              {r.name}
            </Link>
            <CharacterStatusBadge status={r.status} />
            {r.hasPendingClaim && (
              <span className="rounded border border-amber-700 bg-amber-950/40 px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase text-amber-400">
                Claim pending
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-neutral-500">
            EP {r.ep === null ? "—" : Math.round(r.ep)} · GP {r.gp === null ? "—" : Math.round(r.gp)} · Prio{" "}
            {r.priorityRating?.toFixed(4) ?? "—"}
          </div>
        </div>
      </div>
    );

    const detail = (
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
        <div>
          <dt className="text-neutral-500">Role</dt>
          <dd className="mt-0.5">
            {!r.departed && <RoleBadge role={r.ownerRole ?? "member"} />}
          </dd>
        </div>
        <div>
          <dt className="text-neutral-500">Type</dt>
          <dd className="text-neutral-300">{TYPE_LABEL[r.charType]}</dd>
        </div>
        <div>
          <dt className="text-neutral-500">Class</dt>
          <dd className="text-neutral-300">{r.className}</dd>
        </div>
        <div>
          <dt className="text-neutral-500">Level</dt>
          <dd className="text-neutral-300">{r.level}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-neutral-500">Owner</dt>
          <dd className="text-neutral-300">{r.ownerUsername ?? <span className="text-neutral-600">Unclaimed</span>}</dd>
        </div>
        {r.canManageAccount && (
          <div className="col-span-2 pt-1">
            <Link
              href={`/characters/${r.id}/account`}
              prefetch={false}
              className="inline-flex min-h-9 items-center rounded-full border border-field px-3 py-1 text-xs font-medium text-neutral-300 hover:border-emerald-500/60 hover:text-emerald-300"
            >
              View / manage account
            </Link>
          </div>
        )}
        {r.departed && (
          <div className="col-span-2">
            <span className="rounded border border-red-800 bg-red-950/40 px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase text-red-400">
              Removed from guild
            </span>
          </div>
        )}
      </dl>
    );

    return <MobileCard key={r.id} summary={summary} detail={detail} accent={isNested} />;
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

        <details className="relative text-sm">
          <summary className={`${fieldClasses({ size: "sm" })} flex min-h-11 cursor-pointer list-none items-center sm:min-h-0`}>
            {classFilters.size === 0 ? "All classes" : `${classFilters.size} ${classFilters.size === 1 ? "class" : "classes"}`}
          </summary>
          <fieldset className="absolute z-20 mt-1 max-h-72 w-52 overflow-y-auto rounded-lg border border-border bg-neutral-950 p-2 shadow-xl">
            <legend className="sr-only">Class filters</legend>
            {CLASS_FILTER_OPTIONS.map((c) => (
              <label key={c.id} className="flex min-h-11 cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-neutral-900 sm:min-h-8">
                <input type="checkbox" checked={classFilters.has(c.id)} onChange={() => toggleClass(c.id)} />
                <span>{c.name}</span>
              </label>
            ))}
          </fieldset>
        </details>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Race</span>
          <select value={raceFilter} onChange={(e) => setRaceFilter(e.target.value)} className={fieldClasses({ size: "sm" })}>
            <option value="all">All races</option>
            {RACE_FILTER_OPTIONS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Type</span>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className={fieldClasses({ size: "sm" })}>
            <option value="all">All types</option>
            <option value="main">Mains only</option>
            <option value="alt">Alts only</option>
            <option value="mule">Mules only</option>
          </select>
        </label>

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

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Status</span>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={fieldClasses({ size: "sm" })}>
            <option value="active">Active only</option>
            <option value="all">All statuses</option>
            <option value="inactive">{characterStatusLabel("inactive")}</option>
            <option value="removed">{characterStatusLabel("removed")}</option>
            <option value="departed">Removed from guild</option>
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
          {visibleCount} of {rows.length} character{rows.length === 1 ? "" : "s"}
        </span>
        {hasFilters && (
          <Button type="button" size="sm" variant="outline" onClick={resetFilters}>
            Reset filters
          </Button>
        )}
      </div>

      {/* Mobile: expandable cards instead of a horizontally-scrolled table
          (task 6.5). Hidden/shown by breakpoint, not JS, so both stay
          mounted and in sync with the same `visibleGroups`/`expanded` state. */}
      <div className="mt-4 flex flex-col gap-2 sm:hidden">
        {visibleGroups.map((group) => {
          const hasChildren = group.children.length > 0;
          const isOpen = hasChildren && (expanded.has(group.main.id) || hasSearch || !matches(group.main));
          return (
            <div key={group.main.id} className="flex flex-col gap-2">
              {renderCard(group.main, hasChildren ? { toggle: { open: isOpen, onClick: () => toggleExpanded(group.main.id) } } : {})}
              {hasChildren && isOpen && (
                <div className="ml-3 flex flex-col gap-2 border-l-2 border-l-emerald-700/50 pl-2">
                  {group.children.map((child) => renderCard(child, { nested: true }))}
                </div>
              )}
            </div>
          );
        })}
        {visibleGroups.length === 0 && (
          <div className="rounded-lg border border-border px-3 py-6 text-center text-sm text-neutral-500">
            No characters match these filters.
            {hasFilters && (
              <Button type="button" size="sm" variant="outline" onClick={resetFilters} className="mx-auto mt-3">
                Reset filters
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="mt-4 hidden overflow-x-auto rounded-lg border border-border sm:block">
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
              {hasAccountActions && <th className="px-3 py-2" aria-label="Account actions" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visibleGroups.map((group) => {
              const hasChildren = group.children.length > 0;
              // Auto-open when: the user opened it, it only surfaced via an
              // alt match (so the matching alt is visible), or a search is
              // active at all (LT-34 — the point of searching is to see the
              // whole group, alts included).
              const isOpen = hasChildren && (expanded.has(group.main.id) || hasSearch || !matches(group.main));
              return (
                <Fragment key={group.main.id}>
                  {renderRow(group.main, hasChildren ? { toggle: { open: isOpen, onClick: () => toggleExpanded(group.main.id) } } : {})}
                  {hasChildren && isOpen && group.children.map((child) => renderRow(child, { nested: true }))}
                </Fragment>
              );
            })}
            {visibleGroups.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length + (hasAccountActions ? 1 : 0)} className="px-3 py-6 text-center text-neutral-500">
                  No characters match these filters.
                  {hasFilters && (
                    <Button type="button" size="sm" variant="outline" onClick={resetFilters} className="mx-auto mt-3">
                      Reset filters
                    </Button>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
