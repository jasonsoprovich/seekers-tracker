export function ProgressBar({
  done,
  total,
  height = "sm",
  showLabel = true,
  suffix = "",
}: {
  done: number;
  total: number;
  height?: "sm" | "md";
  showLabel?: boolean;
  suffix?: string;
}) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const complete = done === total && total > 0;
  return (
    <div className="flex items-center gap-2">
      <div className={`${height === "md" ? "h-2" : "h-1.5"} flex-1 overflow-hidden rounded-full bg-neutral-800`}>
        <div
          className={`h-full rounded-full transition-all ${complete ? "bg-accent" : "bg-progress"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {showLabel && (
        <span className={`shrink-0 text-[11px] tabular-nums ${complete ? "text-emerald-400" : "text-neutral-500"}`}>
          {done} / {total}
          {suffix}
        </span>
      )}
    </div>
  );
}
