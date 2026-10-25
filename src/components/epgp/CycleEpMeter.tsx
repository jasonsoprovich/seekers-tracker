import { GUILD_TIMEZONE, toGuildDateString } from "@/lib/guild-timezone";

function shortDay(d: Date, timeZone: string): string {
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone });
}

// When the cap resets, in words. A running cycle ends when the guild leader
// runs cycle decay, so this is never a hard deadline: it gives the day the
// cycle was planned to end (a stored UTC-midnight date), or, for a cycle a
// decay opened with no planned day, when it started.
export function cycleResetNote(c: { open: boolean; start: Date; plannedEnd: Date | null }, now: Date): string | null {
  if (!c.open) return null;
  if (c.plannedEnd) {
    const day = shortDay(c.plannedEnd, "UTC");
    const past = c.plannedEnd.toISOString().slice(0, 10) < toGuildDateString(now);
    return past
      ? `Resets when the guild leader runs cycle decay. It was planned for ${day}, so expect it soon.`
      : `Resets when the guild leader runs cycle decay, planned for ${day}.`;
  }
  return `Started ${shortDay(c.start, GUILD_TIMEZONE)}. Resets when the guild leader runs the next cycle decay.`;
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
