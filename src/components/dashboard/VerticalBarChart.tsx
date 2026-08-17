export interface BarSegment {
  value: number;
  color: string;
  opacity?: number;
  title: string;
}

export interface Bar {
  key: string;
  label: string;
  labelTitle?: string;
  segments: BarSegment[];
  total: number;
}

const BAR_HEIGHT = 144;
const YAXIS_WIDTH = 28;

// Round tick step (1/2/5 x 10^n) targeting ~4 gridlines, so labels land on
// clean numbers rather than whatever the max value happens to be.
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

// Shared vertical bar chart: a fixed-height, gridlined plot area with an
// evenly-spaced (justify-between, not fixed-width-and-left-packed) row of
// columns, so the chart fills whatever width its card gets instead of
// clustering at the left with dead space on the right. Bars can carry
// multiple stacked segments (e.g. main/alt as two shades of one hue).
// Tick labels and gridlines share one BAR_HEIGHT-tall box with no padding,
// so their positions stay pixel-exact instead of drifting apart under
// separately-computed layouts.
export function VerticalBarChart({ bars }: { bars: Bar[] }) {
  const maxTotal = Math.max(1, ...bars.map((b) => b.total));
  const ticks = niceTicks(maxTotal);
  const niceMax = ticks[ticks.length - 1]!;

  return (
    <div>
      <div className="flex gap-2">
        <div
          className="flex shrink-0 flex-col justify-between text-right text-[10px] text-neutral-500"
          style={{ height: BAR_HEIGHT, width: YAXIS_WIDTH }}
        >
          {[...ticks].reverse().map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>

        <div className="relative flex flex-1 justify-between gap-1" style={{ height: BAR_HEIGHT }}>
          {ticks.map((t) => (
            <div
              key={t}
              className="pointer-events-none absolute right-0 left-0 border-t border-neutral-800"
              style={{ bottom: `${(t / niceMax) * BAR_HEIGHT}px` }}
            />
          ))}

          {bars.map((b) => (
            <div
              key={b.key}
              className="relative z-10 flex max-w-12 flex-1 flex-col-reverse"
              style={{ height: BAR_HEIGHT }}
            >
              {b.segments.map((s, i) => {
                if (s.value <= 0) return null;
                const px = (s.value / niceMax) * BAR_HEIGHT;
                const isLast = i === b.segments.length - 1;
                return (
                  <div
                    key={i}
                    title={s.title}
                    className={`w-full ${isLast ? "rounded-t-sm" : ""}`}
                    style={{ height: `${px}px`, backgroundColor: s.color, opacity: s.opacity ?? 1, marginTop: i > 0 ? 2 : 0 }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="mt-1.5 flex gap-2">
        <div className="shrink-0" style={{ width: YAXIS_WIDTH }} />
        <div className="flex flex-1 justify-between gap-1">
          {bars.map((b) => (
            <div key={b.key} className="flex max-w-12 flex-1 flex-col items-center gap-0.5">
              <span className="text-[10px] font-medium text-neutral-500" title={b.labelTitle}>
                {b.label}
              </span>
              <span className="text-[9px] text-neutral-600 tabular-nums">{b.total}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
