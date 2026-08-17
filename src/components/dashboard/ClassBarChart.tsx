import { CHAR_CLASSES, classColor } from "@/lib/eq/enums";

export interface ClassCompositionRow {
  id: number;
  abbr: string;
  main: number;
  alt: number;
}

const BAR_HEIGHT = 144;
const YAXIS_WIDTH = 28;

// Round tick step (1/2/5 x 10^n) targeting ~4 gridlines, so labels land on
// clean numbers rather than whatever the max roster count happens to be.
function niceTicks(maxVal: number, targetCount = 4): number[] {
  if (maxVal <= 0) return [0];
  const rawStep = maxVal / targetCount;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const norm = rawStep / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const niceMax = Math.ceil(maxVal / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= niceMax + 1e-9; v += step) ticks.push(Math.round(v));
  return ticks;
}

// Vertical column per class, colored with the class's own hue (same palette
// pq-companion uses for DPS/player-tracker class identity — see
// lib/eq/enums.ts CLASS_COLORS) so a class reads as the same color across
// both apps. Main/alt split rides the same hue as two shades (main at full
// opacity, alt dimmed) rather than a second series color, since the bar's
// hue is already spoken for by class identity. Tick labels and gridlines
// share one BAR_HEIGHT-tall box with no padding, so their positions stay
// pixel-exact instead of drifting apart under separately-computed layouts.
export function ClassBarChart({ rows }: { rows: ClassCompositionRow[] }) {
  const maxTotal = Math.max(1, ...rows.map((r) => r.main + r.alt));
  const ticks = niceTicks(maxTotal);
  const niceMax = ticks[ticks.length - 1]!;

  return (
    <div>
      <div className="mb-3 flex items-center gap-4 text-xs text-neutral-400">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-neutral-300" />
          Main
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-neutral-300 opacity-40" />
          Alt
        </span>
      </div>

      <div className="flex gap-2">
        <div
          className="flex shrink-0 flex-col justify-between text-right text-[10px] text-neutral-500"
          style={{ height: BAR_HEIGHT, width: YAXIS_WIDTH }}
        >
          {[...ticks].reverse().map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>

        <div className="relative flex flex-1 gap-2 overflow-x-auto" style={{ height: BAR_HEIGHT }}>
          {ticks.map((t) => (
            <div
              key={t}
              className="pointer-events-none absolute right-0 left-0 border-t border-neutral-800"
              style={{ bottom: `${(t / niceMax) * BAR_HEIGHT}px` }}
            />
          ))}

          {rows.map((r) => {
            const color = classColor(r.id);
            const mainPx = (r.main / niceMax) * BAR_HEIGHT;
            const altPx = (r.alt / niceMax) * BAR_HEIGHT;
            return (
              <div
                key={r.id}
                className="relative z-10 flex w-6 shrink-0 flex-col-reverse"
                style={{ height: BAR_HEIGHT }}
              >
                {r.main > 0 && (
                  <div
                    title={`${r.abbr} mains: ${r.main}`}
                    className={`w-full ${r.alt === 0 ? "rounded-t-sm" : ""}`}
                    style={{ height: `${mainPx}px`, backgroundColor: color }}
                  />
                )}
                {r.alt > 0 && (
                  <div
                    title={`${r.abbr} alts: ${r.alt}`}
                    className="w-full rounded-t-sm"
                    style={{ height: `${altPx}px`, backgroundColor: color, opacity: 0.4, marginTop: r.main > 0 ? 2 : 0 }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-1.5 flex gap-2">
        <div className="shrink-0" style={{ width: YAXIS_WIDTH }} />
        <div className="flex flex-1 gap-2 overflow-x-auto">
          {rows.map((r) => (
            <div key={r.id} className="flex w-6 shrink-0 flex-col items-center gap-0.5">
              <span
                className="text-[10px] font-medium text-neutral-500"
                title={CHAR_CLASSES.find((c) => c.id === r.id)?.name}
              >
                {r.abbr}
              </span>
              <span className="text-[9px] text-neutral-600 tabular-nums">{r.main + r.alt}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
