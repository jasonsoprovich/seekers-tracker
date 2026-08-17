"use client";

import { useState } from "react";

import { Card } from "@/components/ui/Card";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";

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

  return (
    <Card className="px-6 py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs tracking-wider text-neutral-500 uppercase">Guild PoP progress</p>
        <SegmentedToggle
          value={scope}
          onChange={(v) => setScope(v as "mains" | "all")}
          options={[
            { value: "mains", label: "Mains only" },
            { value: "all", label: "Include alts" },
          ]}
        />
      </div>
      <p className="mt-2 text-5xl font-semibold text-neutral-100">{pct}%</p>
      <div className="mt-3">
        <ProgressBar done={tally.done} total={tally.total} height="md" showLabel={false} />
      </div>
      <p className="mt-2 text-sm text-neutral-400 tabular-nums">
        {tally.done} / {tally.total} non-optional flags complete
      </p>
    </Card>
  );
}
