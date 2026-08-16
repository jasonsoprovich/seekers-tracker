"use client";

import { useState } from "react";

interface Tally {
  done: number;
  total: number;
}

// A single ratio against a limit -> meter + hero figure, not a chart. Both
// scopes are precomputed server-side (§7: "officers will want both views —
// 'is the guild ready' usually means mains only"), so the toggle is a pure
// client-side switch with no round trip.
export function GuildPopMeter({ mainsOnly, all }: { mainsOnly: Tally; all: Tally }) {
  const [scope, setScope] = useState<"mains" | "all">("mains");
  const tally = scope === "mains" ? mainsOnly : all;
  const pct = tally.total === 0 ? 0 : Math.round((tally.done / tally.total) * 100);
  const complete = tally.done === tally.total && tally.total > 0;

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-6 py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs tracking-wider text-neutral-500 uppercase">Guild PoP progress</p>
        <div className="flex overflow-hidden rounded-full border border-neutral-700 text-xs">
          <button
            type="button"
            onClick={() => setScope("mains")}
            className={`px-3 py-1 font-medium transition-colors ${
              scope === "mains" ? "bg-neutral-700 text-neutral-100" : "text-neutral-400 hover:text-neutral-200"
            }`}
          >
            Mains only
          </button>
          <button
            type="button"
            onClick={() => setScope("all")}
            className={`px-3 py-1 font-medium transition-colors ${
              scope === "all" ? "bg-neutral-700 text-neutral-100" : "text-neutral-400 hover:text-neutral-200"
            }`}
          >
            Include alts
          </button>
        </div>
      </div>
      <p className="mt-2 text-5xl font-semibold text-neutral-100">{pct}%</p>
      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-neutral-800">
        <div
          className={`h-full rounded-full transition-all ${complete ? "bg-emerald-500" : "bg-sky-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-2 text-sm text-neutral-400 tabular-nums">
        {tally.done} / {tally.total} non-optional flags complete
      </p>
    </div>
  );
}
