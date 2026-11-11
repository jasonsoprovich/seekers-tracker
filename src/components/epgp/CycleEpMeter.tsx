import { toGuildDateString } from "@/lib/guild-timezone";

function shortDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

// When the cap resets, in words. Cycle decay runs automatically at midnight
// Eastern at the end of the cycle's last day (cycles.ts scheduledCycleEnd),
// and that is when the cap resets.
export function cycleResetNote(c: { open: boolean; scheduledEnd: { lastDay: string; decayAt: Date } | null }, now: Date): string | null {
  if (!c.open || !c.scheduledEnd) return null;
  const { lastDay, decayAt } = c.scheduledEnd;
  if (now >= decayAt) return `This cycle ended at midnight Eastern after ${shortDay(lastDay)}. The cap resets as soon as cycle decay finishes.`;
  const daysLeft = Math.round((Date.parse(`${lastDay}T00:00:00Z`) - Date.parse(`${toGuildDateString(now)}T00:00:00Z`)) / 86_400_000);
  const when = daysLeft === 0 ? "tonight" : daysLeft === 1 ? "tomorrow night" : `in ${daysLeft} days`;
  return `Cycle ends at midnight Eastern after ${shortDay(lastDay)} (${when}). The cap resets then, and EP earned after midnight counts toward the next cycle.`;
}

// EP earned this cycle against the per-cycle cap, for one player account.
// `used` is the same net non-decay sum ep-cap.ts clamps against, so what a
// member sees here is exactly how much room the next award will have.
export function CycleEpMeter({
  used,
  cap,
  cycleNumber,
  endsLabel,
  resetNote,
}: {
  used: number;
  cap: number | null;
  cycleNumber: number;
  endsLabel: string | null;
  resetNote: string | null;
}) {
  const earned = Math.round(used);
  const heading = (
    <span className="text-neutral-400">
      This cycle <span className="text-neutral-500">(#{cycleNumber}{endsLabel ? `, ends ${endsLabel}` : ""})</span>
    </span>
  );

  const reset = resetNote && <p className="mt-1 text-xs text-neutral-500">{resetNote}</p>;

  if (cap === null) {
    return (
      <div>
        <div className="flex items-baseline justify-between gap-3 text-sm">
          {heading}
          <span className="font-mono tabular-nums text-emerald-400">{earned} EP</span>
        </div>
        {reset}
      </div>
    );
  }

  const remaining = Math.max(0, Math.round(cap - used));
  const pct = Math.min(100, Math.max(0, (used / cap) * 100));
  const atCap = used >= cap;
  const nearCap = !atCap && pct >= 80;
  const tone = atCap ? "text-red-400" : nearCap ? "text-amber-300" : "text-emerald-400";
  const bar = atCap ? "bg-red-500" : nearCap ? "bg-amber-400" : "bg-emerald-500";

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        {heading}
        <span className={`font-mono tabular-nums ${tone}`}>
          {earned} / {cap} EP
        </span>
      </div>
      <div
        className="mt-1.5 h-2 overflow-hidden rounded-full bg-neutral-800"
        role="meter"
        aria-label="EP earned this cycle"
        aria-valuemin={0}
        aria-valuemax={cap}
        aria-valuenow={Math.min(earned, cap)}
      >
        <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
      </div>
      <p className={`mt-1 text-xs ${atCap ? "text-red-300" : "text-neutral-500"}`}>
        {atCap
          ? "At the cycle cap. Further EP this cycle is recorded as 0 until the next cycle starts."
          : `${remaining} EP left before the cap. An award that goes over it only adds up to the cap.`}
      </p>
      {reset}
    </div>
  );
}
