import { SERIES_MAIN } from "./colors";

export interface LevelBracketRow {
  label: string;
  count: number;
}

// Single-series magnitude comparison — one flat hue, direct-labeled, no
// legend (a single series needs none; the section heading names it).
export function LevelBracketChart({ rows }: { rows: LevelBracketRow[] }) {
  const maxCount = Math.max(1, ...rows.map((r) => r.count));

  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2">
          <span className="w-14 shrink-0 text-xs font-medium text-neutral-400">{r.label}</span>
          <div className="h-5 flex-1 overflow-hidden rounded-sm bg-neutral-900">
            {r.count > 0 && (
              <div
                title={`Level ${r.label}: ${r.count}`}
                className="h-full rounded-r-sm"
                style={{ width: `${(r.count / maxCount) * 100}%`, backgroundColor: SERIES_MAIN }}
              />
            )}
          </div>
          <span className="w-6 shrink-0 text-right text-xs text-neutral-500 tabular-nums">{r.count}</span>
        </div>
      ))}
    </div>
  );
}
