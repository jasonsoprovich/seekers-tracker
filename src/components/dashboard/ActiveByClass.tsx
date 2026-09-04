"use client";

import { useMemo, useState } from "react";

import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { CHAR_CLASSES } from "@/lib/eq/enums";

export type ActiveRosterEntry = {
  name: string;
  classId: number;
  isAlt: boolean;
  // The player's Loot Priority, shared by all their characters.
  priority: number;
  // Most recent EP/GP ledger activity for the player, in ms. The page only
  // sends characters whose player has some activity.
  lastActivityMs: number;
};

const DAY = 86_400_000;
const WINDOWS = [
  { value: "1d", label: "24h", ms: DAY },
  { value: "7d", label: "7 days", ms: 7 * DAY },
  { value: "30d", label: "1 month", ms: 30 * DAY },
  { value: "365d", label: "1 year", ms: 365 * DAY },
] as const;

// OpenDKP-style "who's been active" board (leader request, 2026-09-04):
// one column per class, each listing that class's characters with ledger
// activity inside the selected window, ranked by the player's current Loot
// Priority. Mains and alts both appear; an alt is dimmed and tagged so the
// column still reads as "these mains, plus some alts". Empty classes are
// hidden to keep it tight. Window filtering is pure client-side — the page
// sends the whole active roster once.
export function ActiveByClass({ roster, nowMs }: { roster: ActiveRosterEntry[]; nowMs: number }) {
  const [win, setWin] = useState<string>("30d");
  const cutoff = nowMs - (WINDOWS.find((w) => w.value === win)?.ms ?? 30 * DAY);

  const columns = useMemo(() => {
    const inWindow = roster.filter((e) => e.lastActivityMs >= cutoff);
    return CHAR_CLASSES.map((cls) => ({
      cls,
      members: inWindow.filter((e) => e.classId === cls.id).sort((a, b) => b.priority - a.priority),
    })).filter((col) => col.members.length > 0);
  }, [roster, cutoff]);

  const total = columns.reduce((n, c) => n + c.members.length, 0);

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Active Members by Class</h2>
          <p className="mt-1 text-sm text-neutral-400">
            Characters with EP or GP activity in the window, ranked by Loot Priority. {total} shown.
          </p>
        </div>
        <SegmentedToggle value={win} onChange={setWin} options={WINDOWS.map((w) => ({ value: w.value, label: w.label }))} />
      </div>

      {columns.length === 0 ? (
        <p className="mt-4 text-sm text-neutral-500">No activity in this window.</p>
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
                    <span className={m.isAlt ? "truncate text-neutral-500" : "truncate text-neutral-200"}>
                      {m.name}
                      {m.isAlt && <span className="ml-1 text-[10px] uppercase tracking-wide text-neutral-600">alt</span>}
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
  );
}
