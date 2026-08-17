"use client";

import { useState } from "react";

import { SegmentedToggle } from "@/components/ui/SegmentedToggle";

interface Tally {
  done: number;
  total: number;
}

export interface ClassPopRow {
  id: number;
  abbr: string;
  mainsOnly: Tally;
  all: Tally;
}

// Per-class PoP completion (§7: "same aggregate, grouped by class"). Mirrors
// GuildPopMeter's mains/all toggle so officers get the same two views down
// at class granularity — both tallies are precomputed server-side, the
// toggle is a pure client-side switch. One row per class, even at zero
// total, so a class with no characters reads as "no data" rather than
// silently disappearing from the list.
export function ClassPopChart({ rows }: { rows: ClassPopRow[] }) {
  const [scope, setScope] = useState<"mains" | "all">("mains");

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <SegmentedToggle
          value={scope}
          onChange={(v) => setScope(v as "mains" | "all")}
          options={[
            { value: "mains", label: "Mains only" },
            { value: "all", label: "Include alts" },
          ]}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        {rows.map((r) => {
          const tally = scope === "mains" ? r.mainsOnly : r.all;
          const pct = tally.total === 0 ? 0 : Math.round((tally.done / tally.total) * 100);
          const complete = tally.done === tally.total && tally.total > 0;
          return (
            <div key={r.id} className="flex items-center gap-2">
              <span className="w-10 shrink-0 text-xs font-medium text-neutral-400">{r.abbr}</span>
              <div className="h-5 flex-1 overflow-hidden rounded-sm bg-neutral-900">
                {tally.total > 0 && (
                  <div
                    title={`${r.abbr}: ${tally.done}/${tally.total} (${pct}%)`}
                    className={`h-full rounded-r-sm transition-all ${complete ? "bg-emerald-500" : "bg-sky-500"}`}
                    style={{ width: `${pct}%` }}
                  />
                )}
              </div>
              <span className="w-10 shrink-0 text-right text-xs text-neutral-500 tabular-nums">
                {tally.total === 0 ? "—" : `${pct}%`}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
