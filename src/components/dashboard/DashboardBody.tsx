"use client";

import { useState } from "react";

import { ClassBarChart, type ClassCompositionRow } from "@/components/dashboard/ClassBarChart";
import { ClassPopChart, type ClassPopRow } from "@/components/dashboard/ClassPopChart";
import { GuildPopMeter } from "@/components/dashboard/GuildPopMeter";
import { LevelBarChart, type LevelBracketRow } from "@/components/dashboard/LevelBarChart";
import { StatTile } from "@/components/dashboard/StatTile";
import { Card } from "@/components/ui/Card";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";

export interface DashboardBundle {
  characterCount: number;
  mains: number;
  alts: number;
  mainDone: number;
  mainTotal: number;
  allDone: number;
  allTotal: number;
  classRows: ClassCompositionRow[];
  bracketRows: LevelBracketRow[];
  classPopRows: ClassPopRow[];
}

// Both scopes ("active only" vs "include retired+removed") are precomputed
// server-side — same "toggle is a pure client-side switch, no round trip"
// approach GuildPopMeter's own Mains/Alts toggle already uses. The two
// toggles are independent axes (roster status vs main/alt), so they compose
// rather than needing to be merged into one control.
export function DashboardBody({ all, activeOnly }: { all: DashboardBundle; activeOnly: DashboardBundle }) {
  const [scope, setScope] = useState<"active" | "all">("active");
  const bundle = scope === "active" ? activeOnly : all;

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <SegmentedToggle
          value={scope}
          onChange={(v) => setScope(v as "active" | "all")}
          options={[
            { value: "active", label: "Active only" },
            { value: "all", label: "Include retired+removed" },
          ]}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <StatTile label="Characters" value={bundle.characterCount} />
        <StatTile label="Mains" value={bundle.mains} />
        <StatTile label="Alts" value={bundle.alts} />
        <div className="col-span-2 sm:col-span-3 lg:col-span-1">
          <GuildPopMeter
            mainsOnly={{ done: bundle.mainDone, total: bundle.mainTotal }}
            all={{ done: bundle.allDone, total: bundle.allTotal }}
          />
        </div>
      </div>

      <Card className="mt-4 p-4">
        <h2 className="text-lg font-semibold">Roster by Class</h2>
        <p className="mt-1 text-sm text-neutral-400">Every class shown, even at zero — that&apos;s the gap.</p>
        <div className="mt-4">
          <ClassBarChart rows={bundle.classRows} />
        </div>
      </Card>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="text-lg font-semibold">Roster by Level</h2>
          <p className="mt-1 text-sm text-neutral-400">Share of the guild in each level bracket.</p>
          <div className="mt-4">
            <LevelBarChart rows={bundle.bracketRows} />
          </div>
        </Card>

        <Card className="p-4">
          <h2 className="text-lg font-semibold">PoP Progress by Class</h2>
          <p className="mt-1 text-sm text-neutral-400">Non-optional flags complete, per class.</p>
          <div className="mt-4">
            <ClassPopChart rows={bundle.classPopRows} />
          </div>
        </Card>
      </div>
    </div>
  );
}
