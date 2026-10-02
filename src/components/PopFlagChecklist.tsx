"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { setManualFlag } from "@/app/(app)/characters/[id]/actions";
import PopFlagFlow from "@/components/PopFlagFlow";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { PopFlagRow } from "@/components/PopFlagRow";
import type { FlagStatus, Progress } from "@/lib/pop-flags";

function TierSection({
  progress,
  flags,
  allFlags,
  requiredByDone,
  busyId,
  readOnly,
  onToggle,
}: {
  progress: Progress;
  flags: FlagStatus[];
  allFlags: FlagStatus[];
  requiredByDone: Set<string>;
  busyId: string | null;
  readOnly: boolean;
  onToggle: (flag: FlagStatus) => void;
}) {
  const complete = progress.done === progress.total && progress.total > 0;

  const zones = useMemo(() => {
    const order: string[] = [];
    const byZone = new Map<string, FlagStatus[]>();
    for (const f of flags) {
      if (!byZone.has(f.zone)) {
        byZone.set(f.zone, []);
        order.push(f.zone);
      }
      byZone.get(f.zone)!.push(f);
    }
    return order.map((zone) => ({ zone, flags: byZone.get(zone)! }));
  }, [flags]);

  return (
    <details
      open={progress.done < progress.total}
      className={`overflow-hidden rounded-lg border ${complete ? "border-emerald-700" : "border-neutral-800"} bg-neutral-900/40`}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
        <span className={`flex-1 text-sm font-semibold ${complete ? "text-emerald-400" : "text-neutral-100"}`}>
          {progress.label}
        </span>
        <div className="w-32 shrink-0">
          <ProgressBar done={progress.done} total={progress.total} />
        </div>
      </summary>
      <div className="border-t border-neutral-800">
        {zones.map(({ zone, flags: zoneFlags }) => (
          <div key={zone}>
            <div className="bg-neutral-900/80 px-4 py-1.5 text-[10px] font-semibold tracking-wider text-neutral-500 uppercase">
              {zone}
            </div>
            {zoneFlags.map((f) => (
              <PopFlagRow
                key={f.id}
                flag={f}
                allFlags={allFlags}
                requiredByDone={requiredByDone}
                busy={busyId === f.id}
                readOnly={readOnly}
                onToggle={onToggle}
              />
            ))}
          </div>
        ))}
      </div>
    </details>
  );
}

export function PopFlagChecklist({
  characterId,
  flags,
  tiers,
  readOnly = false,
}: {
  characterId: number;
  flags: FlagStatus[];
  tiers: Progress[];
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"checklist" | "flow">("checklist");

  // Remembered per browser; read after mount so SSR markup stays stable.
  useEffect(() => {
    try {
      if (localStorage.getItem("pop_flag_view") === "flow") setView("flow");
    } catch {}
  }, []);
  function changeView(v: string) {
    const next = v === "flow" ? "flow" : "checklist";
    setView(next);
    try {
      localStorage.setItem("pop_flag_view", next);
    } catch {}
  }

  const requiredByDone = useMemo(() => {
    const s = new Set<string>();
    for (const f of flags) {
      if (f.done) for (const p of f.prereqs) s.add(p);
    }
    return s;
  }, [flags]);

  const byTier = useMemo(() => {
    const m = new Map<number, FlagStatus[]>();
    for (const f of flags) {
      if (!m.has(f.tier)) m.set(f.tier, []);
      m.get(f.tier)!.push(f);
    }
    return tiers.map((t) => ({ progress: t, flags: m.get(t.tier ?? 0) ?? [] }));
  }, [flags, tiers]);

  async function onToggle(flag: FlagStatus) {
    if (readOnly) return;
    setBusyId(flag.id);
    setError(null);
    const result = await setManualFlag(characterId, flag.id, !flag.done);
    setBusyId(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className={`flex items-center justify-between gap-3 ${view === "flow" ? "" : "mx-auto w-full max-w-3xl"}`}>
        <SegmentedToggle
          value={view}
          onChange={changeView}
          options={[
            { value: "checklist", label: "Checklist" },
            { value: "flow", label: "Flow chart" },
          ]}
        />
        {view === "flow" && <span className="text-[11px] text-neutral-500">Same steps as the checklist, laid out by zone.</span>}
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {view === "flow" ? (
        <PopFlagFlow
          flags={flags}
          readOnly={readOnly}
          busyId={busyId}
          requiredByDone={requiredByDone}
          onToggle={onToggle}
        />
      ) : (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
        {byTier.map(({ progress, flags: tierFlags }) => (
          <TierSection
            key={progress.tier}
            progress={progress}
            flags={tierFlags}
            allFlags={flags}
            requiredByDone={requiredByDone}
            busyId={busyId}
            readOnly={readOnly}
            onToggle={onToggle}
          />
        ))}
        </div>
      )}
    </div>
  );
}
