import { SERIES_ALT, SERIES_MAIN } from "./colors";

export interface ClassCompositionRow {
  id: number;
  abbr: string;
  main: number;
  alt: number;
}

// Horizontal stacked bar per class (part-to-whole, main vs alt), one row per
// class so a zero-count class still reads as "we have none of these" — the
// brief's "what classes are we low on" ask. Bars: <=24px thick (h-5 = 20px),
// square baseline (left), 4px rounded data-end (right, only on the segment
// that's actually the bar's tip), 2px surface gap between stacked segments.
export function ClassCompositionChart({ rows }: { rows: ClassCompositionRow[] }) {
  const maxTotal = Math.max(1, ...rows.map((r) => r.main + r.alt));

  return (
    <div>
      <div className="mb-3 flex items-center gap-4 text-xs text-neutral-400">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: SERIES_MAIN }} />
          Main
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: SERIES_ALT }} />
          Alt
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {rows.map((r) => {
          const total = r.main + r.alt;
          const mainPct = (r.main / maxTotal) * 100;
          const altPct = (r.alt / maxTotal) * 100;
          return (
            <div key={r.id} className="flex items-center gap-2">
              <span className="w-10 shrink-0 text-xs font-medium text-neutral-400">{r.abbr}</span>
              <div className="h-5 flex-1 overflow-hidden rounded-sm bg-neutral-900">
                <div className="flex h-full">
                  {r.main > 0 && (
                    <div
                      title={`${r.abbr} mains: ${r.main}`}
                      className={r.alt === 0 ? "h-full rounded-r-sm" : "h-full"}
                      style={{ width: `${mainPct}%`, backgroundColor: SERIES_MAIN }}
                    />
                  )}
                  {r.alt > 0 && (
                    <div
                      title={`${r.abbr} alts: ${r.alt}`}
                      className="h-full rounded-r-sm"
                      style={{ width: `${altPct}%`, backgroundColor: SERIES_ALT, marginLeft: r.main > 0 ? 2 : 0 }}
                    />
                  )}
                </div>
              </div>
              <span className="w-6 shrink-0 text-right text-xs text-neutral-500 tabular-nums">{total}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
