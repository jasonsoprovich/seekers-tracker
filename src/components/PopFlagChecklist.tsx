"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { setManualFlag } from "@/app/(app)/characters/[id]/actions";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { roleMeta, stepKindMeta, type FlagStatus, type Progress } from "@/lib/pop-flags";

function SourceChip({ source }: { source?: string }) {
  if (!source) return null;
  return (
    <span className="ml-2 shrink-0 rounded border border-neutral-700 bg-neutral-800/60 px-1.5 py-0.5 text-[9px] tracking-wider text-neutral-400 uppercase">
      {source}
    </span>
  );
}

function FlagRow({
  flag,
  allFlags,
  requiredByDone,
  busy,
  readOnly,
  onToggle,
}: {
  flag: FlagStatus;
  allFlags: FlagStatus[];
  requiredByDone: Set<string>;
  busy: boolean;
  readOnly: boolean;
  onToggle: (flag: FlagStatus) => void;
}) {
  const missingLabels = (flag.missing ?? [])
    .map((id) => allFlags.find((f) => f.id === id)?.label ?? id)
    .join(", ");
  const lockedForCheck = flag.locked && !flag.done;
  const lockedForUncheck = flag.done && requiredByDone.has(flag.id);
  // An any-of anchor satisfied via a checked member: toggling it would be a
  // no-op, so steer the member toward the member row instead.
  const anchorViaMember = flag.done && allFlags.some((o) => o.group === flag.id && o.done);
  const disabled = readOnly || busy || lockedForCheck || lockedForUncheck || anchorViaMember;
  const title = readOnly
    ? "You don't have permission to edit this character"
    : lockedForCheck
      ? `Complete prerequisites first: ${missingLabels}`
      : lockedForUncheck
        ? "Required by a completed later step"
        : anchorViaMember
          ? "Completed via an option below — toggle that instead"
          : flag.done
            ? "Mark not done"
            : "Mark done";

  const km = stepKindMeta(flag.step_kind);
  const rm = roleMeta(flag.role);
  const dimmed = flag.done || flag.superseded;

  return (
    <div
      className={`flex items-start gap-2 border-t border-neutral-800 px-4 py-2 ${flag.group ? "pl-8" : ""}`}
      style={{ opacity: flag.superseded ? 0.45 : flag.locked && !flag.done ? 0.6 : rm && !flag.done ? 0.85 : 1 }}
    >
      <button
        type="button"
        onClick={() => onToggle(flag)}
        disabled={disabled}
        title={title}
        className={`mt-0.5 shrink-0 text-base leading-none ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
      >
        {flag.done ? <span className="text-emerald-400">●</span> : <span className="text-neutral-600">○</span>}
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className={dimmed ? "text-sm text-neutral-500 line-through" : "text-sm text-neutral-100"}>
            {flag.label}
          </span>
          {km && (
            <span className={`rounded border px-1.5 py-0.5 text-[9px] tracking-wider uppercase ${km.className}`} title={km.tip}>
              {km.label}
            </span>
          )}
          {rm && (
            <span className={`rounded border px-1.5 py-0.5 text-[9px] tracking-wider uppercase ${rm.className}`} title={rm.tip}>
              {rm.label}
            </span>
          )}
          {flag.superseded && (
            <span
              className="rounded border border-neutral-700 bg-neutral-800/60 px-1.5 py-0.5 text-[9px] tracking-wider text-neutral-400 uppercase"
              title="Another option in this group is done — this one is no longer needed."
            >
              not needed
            </span>
          )}
          {flag.locked && !flag.done && (
            <span title={`Needs: ${missingLabels}`} className="text-[11px] text-red-400">
              🔒
            </span>
          )}
          {flag.level ? <span className="text-[10px] text-neutral-500">L{flag.level}</span> : null}
          {flag.done && <SourceChip source={flag.source} />}
        </div>
        {flag.detail && <p className="mt-0.5 text-[11px] leading-snug text-neutral-500">{flag.detail}</p>}
      </div>
    </div>
  );
}

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
              <FlagRow
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
      {error && <p className="text-sm text-red-400">{error}</p>}
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
  );
}
