"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { fieldClasses } from "@/components/ui/Field";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { CHAR_CLASSES } from "@/lib/eq/enums";
import type { ZoneCatalogEntry, ZoneState, ZoneStatus } from "@/lib/pop-flags";

export interface ProgressionRow {
  id: number;
  name: string;
  ownerUsername: string;
  classId: number;
  className: string;
  level: number;
  charType: "main" | "alt";
  done: number;
  total: number;
  tiers: { tier: number; label: string; done: number; total: number }[];
  zones: ZoneStatus[];
}

type SortKey = "name" | "ownerUsername" | "className" | "level" | "charType" | "pct";
type SortDir = "asc" | "desc";

function pct(row: ProgressionRow): number {
  return row.total === 0 ? 0 : Math.round((row.done / row.total) * 100);
}

function compare(a: ProgressionRow, b: ProgressionRow, key: SortKey): number {
  if (key === "pct") return pct(a) - pct(b);
  const av = a[key];
  const bv = b[key];
  if (typeof av === "number" && typeof bv === "number") return av - bv;
  return String(av).localeCompare(String(bv));
}

// The highest tier with any progress, labeled done if that tier's
// non-optional flags are all complete — a one-glance "where are they"
// summary next to the full progress bar.
function currentTierLabel(tiers: ProgressionRow["tiers"]): string {
  let label = "Not started";
  for (const t of tiers) {
    if (t.done === 0) continue;
    label = t.total > 0 && t.done === t.total ? `${t.label} ✓` : t.label;
  }
  return label;
}

// Hand-authored short labels for the milestone grid's zone columns — a
// generic initialism collides too often (Torment/Tactics/Time all reduce to
// "PoT"). Falls back to a truncated zone name for anything not listed here,
// so a future pop-flags.json zone addition still renders instead of
// breaking.
const ZONE_ABBR: Record<string, string> = {
  "Plane of Justice": "PoJ",
  "Plane of Nightmares": "PoN",
  "Plane of Disease": "PoDis",
  "Plane of Innovation": "PoInn",
  "Plane of Storms": "PoStorm",
  "Plane of Valor": "PoValor",
  "Crypt of Decay": "CoD",
  "Halls of Honor": "HoH",
  "Plane of Torment": "PoTorm",
  "Plane of Tactics": "PoTact",
  "Bastion of Thunder": "BoT",
  "Plane of Knowledge": "PoK",
  "Tower of Solusek Ro": "ToSR",
  "Plane of Air": "PoAir",
  "Plane of Earth": "PoEarth",
  "Plane of Water": "PoWater",
  "Plane of Fire": "PoFire",
  "Plane of Time": "PoTime",
};

function zoneAbbr(zone: string): string {
  return ZONE_ABBR[zone] ?? zone.slice(0, 6);
}

const STATE_META: Record<ZoneState, { swatch: string; label: string }> = {
  locked: { swatch: "bg-neutral-900 border border-neutral-800", label: "Locked" },
  available: { swatch: "bg-neutral-700", label: "Unlocked, not started" },
  in_progress: { swatch: "bg-sky-500", label: "In progress" },
  complete: { swatch: "bg-emerald-500", label: "Complete" },
};

function ZoneCell({ zone }: { zone: ZoneStatus }) {
  const meta = STATE_META[zone.state];
  return (
    <td className="px-0.5 py-1.5 text-center">
      <div
        title={`${zone.zone} — ${zone.done}/${zone.total} (${meta.label})`}
        className={`mx-auto h-4 w-4 rounded-sm ${meta.swatch}`}
      />
    </td>
  );
}

function MilestoneGraph({ rows, zoneCatalog }: { rows: ProgressionRow[]; zoneCatalog: ZoneCatalogEntry[] }) {
  const tierBands = useMemo(() => {
    const bands: { tier: number; zones: ZoneCatalogEntry[] }[] = [];
    for (const z of zoneCatalog) {
      const band = bands.find((b) => b.tier === z.tier);
      if (band) band.zones.push(z);
      else bands.push({ tier: z.tier, zones: [z] });
    }
    return bands;
  }, [zoneCatalog]);

  if (rows.length === 0) {
    return <p className="mt-4 text-sm text-neutral-500">No characters match these filters.</p>;
  }

  return (
    <div className="mt-4">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-neutral-900/60 text-[10px] tracking-wide text-neutral-500 uppercase">
              <th className="sticky left-0 z-10 bg-neutral-900 px-3 py-1.5 font-medium">&nbsp;</th>
              {tierBands.map((band) => (
                <th
                  key={band.tier}
                  colSpan={band.zones.length}
                  className="border-l border-border px-1 py-1.5 text-center font-medium"
                >
                  Tier {band.tier}
                </th>
              ))}
            </tr>
            <tr className="border-b border-border bg-neutral-900/60 text-[9px] tracking-wide text-neutral-500 uppercase">
              <th className="sticky left-0 z-10 bg-neutral-900 px-3 py-1 text-left font-medium">Character</th>
              {zoneCatalog.map((z, i) => {
                const isBandStart = i === 0 || zoneCatalog[i - 1]!.tier !== z.tier;
                return (
                  <th
                    key={z.zone}
                    title={z.zone}
                    className={`px-0.5 py-1 text-center font-medium whitespace-nowrap ${isBandStart ? "border-l border-border" : ""}`}
                  >
                    {zoneAbbr(z.zone)}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-neutral-900/40">
                <td className="sticky left-0 z-10 min-w-[10rem] bg-neutral-950 px-3 py-1.5">
                  <Link href={`/characters/${r.id}`} className="font-medium hover:text-emerald-400">
                    {r.name}
                  </Link>
                  <span className="ml-1.5 text-xs text-neutral-500">{r.charType === "main" ? "Main" : "Alt"}</span>
                </td>
                {r.zones.map((z, i) => {
                  const isBandStart = i === 0 || r.zones[i - 1]!.tier !== z.tier;
                  return (
                    <td key={z.zone} className={isBandStart ? "border-l border-border" : ""}>
                      <ZoneCell zone={z} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-neutral-500">
        {(Object.keys(STATE_META) as ZoneState[]).map((state) => (
          <span key={state} className="flex items-center gap-1.5">
            <span className={`h-3 w-3 rounded-sm ${STATE_META[state].swatch}`} />
            {STATE_META[state].label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function PopProgressionView({ rows, zoneCatalog }: { rows: ProgressionRow[]; zoneCatalog: ZoneCatalogEntry[] }) {
  const [search, setSearch] = useState("");
  const [classFilter, setClassFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !r.name.toLowerCase().includes(q) && !r.ownerUsername.toLowerCase().includes(q)) return false;
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
      setSortDir(key === "pct" ? "desc" : "asc");
    }
  }

  const COLUMNS: { key: SortKey; label: string }[] = [
    { key: "name", label: "Name" },
    { key: "ownerUsername", label: "Owner" },
    { key: "charType", label: "Type" },
    { key: "className", label: "Class" },
    { key: "level", label: "Level" },
    { key: "pct", label: "Progress" },
  ];

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
        <table className="w-full min-w-[720px] text-left text-sm">
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
                <td className="px-3 py-2 text-neutral-400">{r.charType === "main" ? "Main" : "Alt"}</td>
                <td className="px-3 py-2 text-neutral-400">{r.className}</td>
                <td className="px-3 py-2 text-neutral-400">{r.level}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-3">
                    <div className="w-28 shrink-0">
                      <ProgressBar done={r.done} total={r.total} />
                    </div>
                    <span className="text-xs text-neutral-500">{currentTierLabel(r.tiers)}</span>
                  </div>
                </td>
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

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Zone Milestones</h2>
        <p className="mt-1 text-sm text-neutral-400">
          Which zones are unlocked, in progress, or cleared per character — grouped by tier. Hover a cell for detail.
        </p>
        <MilestoneGraph rows={sorted} zoneCatalog={zoneCatalog} />
      </section>
    </div>
  );
}
