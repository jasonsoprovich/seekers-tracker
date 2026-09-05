"use client";

import { useMemo, useState } from "react";

import { CHAR_CLASSES, classColor } from "@/lib/eq/enums";

import { Card } from "../ui/Card";
import { SegmentedToggle } from "../ui/SegmentedToggle";
import { VerticalBarChart, type Bar } from "./VerticalBarChart";

export type RosterEntry = {
  name: string;
  classId: number;
  charType: "main" | "alt";
  priority: number;
  // Most recent EP/GP ledger row for THIS character (character-activity.ts)
  // — null means never active, still shown under "All time" but excluded
  // by every windowed option.
  lastActivityMs: number | null;
};

const DAY = 86_400_000;
const WINDOWS = [
  { value: "1d", label: "24h", ms: DAY },
  { value: "7d", label: "7 days", ms: 7 * DAY },
  { value: "30d", label: "1 month", ms: 30 * DAY },
  { value: "365d", label: "1 year", ms: 365 * DAY },
  { value: "all", label: "All time", ms: Infinity },
] as const;

// Leader request, 2026-09-05: "the characters, mains alts, etc and roster
// by class should all be linked to the active time filter, perhaps we just
// have one filter thing stickied to the top that toggles alts on and off,
// and then timeline toggles and also add all time to that." One filter
// (alts on/off + time window, "All time" included) drives all three
// sections below — replacing what used to be three separate/duplicated
// toggles (the dashboard's own Active-only/Include-inactive+removed
// scope switch, since removed; ActiveByClass's own window toggle, folded
// in here). Mules are excluded upstream (dashboard/page.tsx never sends
// one into `roster`), matching "mules can be ignored".
export function RosterOverview({ roster, nowMs }: { roster: RosterEntry[]; nowMs: number }) {
  const [showAlts, setShowAlts] = useState(true);
  const [win, setWin] = useState<string>("all");
  const windowDef = WINDOWS.find((w) => w.value === win) ?? WINDOWS[WINDOWS.length - 1];
  const cutoff = nowMs - windowDef.ms;

  const filtered = useMemo(
    () =>
      roster.filter((e) => {
        if (!showAlts && e.charType === "alt") return false;
        if (windowDef.ms === Infinity) return true;
        return e.lastActivityMs !== null && e.lastActivityMs >= cutoff;
      }),
    [roster, showAlts, cutoff, windowDef.ms],
  );

  const mains = filtered.filter((e) => e.charType === "main").length;
  const alts = filtered.length - mains;

  const classBars: Bar[] = useMemo(() => {
    const byClass = new Map<number, { main: number; alt: number }>();
    for (const e of filtered) {
      const cls = byClass.get(e.classId) ?? { main: 0, alt: 0 };
      if (e.charType === "main") cls.main++;
      else cls.alt++;
      byClass.set(e.classId, cls);
    }
    return CHAR_CLASSES.map((cl) => {
      const c = byClass.get(cl.id) ?? { main: 0, alt: 0 };
      const color = classColor(cl.id);
      return {
        key: String(cl.id),
        label: cl.abbr,
        labelTitle: cl.name,
        total: c.main + c.alt,
        segments: [
          { value: c.main, color, title: `${cl.abbr} mains: ${c.main}` },
          { value: c.alt, color, opacity: 0.4, title: `${cl.abbr} alts: ${c.alt}` },
        ],
      };
    });
  }, [filtered]);

  const columns = useMemo(() => {
    return CHAR_CLASSES.map((cls) => ({
      cls,
      members: filtered.filter((e) => e.classId === cls.id).sort((a, b) => b.priority - a.priority),
    })).filter((col) => col.members.length > 0);
  }, [filtered]);

  return (
    <div className="mt-4">
      <div className="sticky top-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 bg-surface/95 px-4 py-3 backdrop-blur">
        <label className="flex items-center gap-2 text-sm text-neutral-300">
          <input type="checkbox" checked={showAlts} onChange={(e) => setShowAlts(e.target.checked)} className="h-4 w-4" />
          Include alts
        </label>
        <SegmentedToggle value={win} onChange={setWin} options={WINDOWS.map((w) => ({ value: w.value, label: w.label }))} />
      </div>

      <Card className="mt-4 px-4 py-3">
        <div className="grid grid-cols-3 gap-3 text-center">
          <div>
            <p className="text-xs tracking-wider text-neutral-500 uppercase">Characters</p>
            <p className="mt-1 text-2xl font-semibold text-neutral-100">{filtered.length}</p>
          </div>
          <div>
            <p className="text-xs tracking-wider text-neutral-500 uppercase">Mains</p>
            <p className="mt-1 text-2xl font-semibold text-neutral-100">{mains}</p>
          </div>
          <div>
            <p className="text-xs tracking-wider text-neutral-500 uppercase">Alts</p>
            <p className="mt-1 text-2xl font-semibold text-neutral-100">{alts}</p>
          </div>
        </div>
      </Card>

      <Card className="mt-4 p-4">
        <h2 className="text-lg font-semibold">Roster by Class</h2>
        <p className="mt-1 text-sm text-neutral-400">Every class shown, even at zero — that&apos;s the gap.</p>
        <div className="mt-4">
          <div className="mb-3 flex items-center gap-4 text-xs text-neutral-400">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-neutral-300" />
              Main
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-neutral-300 opacity-40" />
              Alt
            </span>
          </div>
          <VerticalBarChart bars={classBars} />
        </div>
      </Card>

      <section className="mt-4">
        <h2 className="text-lg font-semibold">Roster by Class — Members</h2>
        <p className="mt-1 text-sm text-neutral-400">Ranked by Loot Priority within the filter above.</p>
        {columns.length === 0 ? (
          <p className="mt-4 text-sm text-neutral-500">No one matches this filter.</p>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {columns.map(({ cls, members }) => (
              <div key={cls.id} className="overflow-hidden rounded-lg border border-border bg-panel">
                <div className="flex items-baseline justify-between border-b border-border px-3 py-2">
                  <span className="text-sm font-semibold">{cls.name}</span>
                  <span className="text-xs text-neutral-500">{members.length}</span>
                </div>
                <ul className="divide-y divide-border/60">
                  {members.map((m, i) => (
                    <li key={`${m.name}-${i}`} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
                      <span className={m.charType === "alt" ? "truncate text-neutral-500" : "truncate text-neutral-200"}>
                        {m.name}
                        {m.charType === "alt" && <span className="ml-1 text-[10px] uppercase tracking-wide text-neutral-600">alt</span>}
                      </span>
                      <span className="shrink-0 font-mono text-emerald-400">{m.priority.toFixed(4)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
