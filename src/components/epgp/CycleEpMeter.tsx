// EP earned this cycle against the per-cycle cap, for one player account.
// `used` is the same net non-decay sum ep-cap.ts clamps against, so what a
// member sees here is exactly how much room the next award will have.
export function CycleEpMeter({
  used,
  cap,
  cycleNumber,
  endsLabel,
}: {
  used: number;
  cap: number | null;
  cycleNumber: number;
  endsLabel: string | null;
}) {
  const earned = Math.round(used);
  const heading = (
    <span className="text-neutral-400">
      This cycle <span className="text-neutral-500">(#{cycleNumber}{endsLabel ? `, ends ${endsLabel}` : ""})</span>
    </span>
  );

  if (cap === null) {
    return (
      <div className="flex items-baseline justify-between gap-3 text-sm">
        {heading}
        <span className="font-mono tabular-nums text-emerald-400">{earned} EP</span>
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
    </div>
  );
}
