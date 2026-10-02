"use client";

import { roleMeta, stepKindMeta, type FlagStatus } from "@/lib/pop-flags";

// One PoP flag as a checkable row. Shared by the Checklist and the Flow view
// (same split as pq-companion's PopFlagRow) so both behave identically — same
// toggle rules, lock tooltips and badges. `compact` drops the detail
// paragraph and tightens padding for the Flow view's zone cards.

function SourceChip({ source }: { source?: string }) {
  if (!source) return null;
  return (
    <span className="ml-2 shrink-0 rounded border border-neutral-700 bg-neutral-800/60 px-1.5 py-0.5 text-[9px] tracking-wider text-neutral-400 uppercase">
      {source}
    </span>
  );
}

export function PopFlagRow({
  flag,
  allFlags,
  requiredByDone,
  busy,
  readOnly,
  onToggle,
  compact = false,
}: {
  flag: FlagStatus;
  allFlags: FlagStatus[];
  requiredByDone: Set<string>;
  busy: boolean;
  readOnly: boolean;
  onToggle: (flag: FlagStatus) => void;
  compact?: boolean;
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
      className={`flex items-start border-t border-neutral-800 ${
        compact ? "gap-1.5 px-2 py-1.5" : "gap-2 px-4 py-2"
      } ${flag.group ? (compact ? "pl-5" : "pl-8") : ""}`}
      style={{ opacity: flag.superseded ? 0.45 : flag.locked && !flag.done ? 0.6 : rm && !flag.done ? 0.85 : 1 }}
    >
      <button
        type="button"
        onClick={() => onToggle(flag)}
        disabled={disabled}
        title={title}
        className={`mt-0.5 shrink-0 leading-none ${compact ? "text-sm" : "text-base"} ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
      >
        {flag.done ? <span className="text-emerald-400">●</span> : <span className="text-neutral-600">○</span>}
      </button>
      <div className="min-w-0 flex-1">
        <div
          className="flex flex-wrap items-center gap-x-1.5 gap-y-1"
          title={compact ? flag.detail : undefined}
        >
          <span
            className={`${compact ? "text-[11px]" : "text-sm"} ${
              dimmed ? "text-neutral-500 line-through" : "text-neutral-100"
            }`}
          >
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
          {!compact && flag.level ? <span className="text-[10px] text-neutral-500">L{flag.level}</span> : null}
          {!compact && flag.done && <SourceChip source={flag.source} />}
        </div>
        {!compact && flag.detail && <p className="mt-0.5 text-[11px] leading-snug text-neutral-500">{flag.detail}</p>}
      </div>
    </div>
  );
}
