export interface LevelBracketRow {
  label: string;
  count: number;
}

// One hue, light -> dark, low bracket to level cap — sequential ramp
// (Tailwind's sky steps) rather than a categorical palette, since level
// brackets are ordinal (magnitude, not identity): darker reads as "further
// along," matching the dataviz convention of more-is-darker.
const RAMP = ["#bae6fd", "#7dd3fc", "#38bdf8", "#0ea5e9", "#0284c7", "#0369a1", "#075985"];

const SIZE = 160;
const STROKE = 26;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const GAP = 2;

// Donut (part-to-whole share of the roster by level bracket) — the shape
// the brief asked for. Ordered by level so the ramp's light-to-dark
// progression reads left-to-right/low-to-high around the ring.
export function LevelDonutChart({ rows }: { rows: LevelBracketRow[] }) {
  const total = rows.reduce((sum, r) => sum + r.count, 0);

  let cumulative = 0;
  const segments = rows.map((r, i) => {
    const frac = total === 0 ? 0 : r.count / total;
    const dash = frac * CIRCUMFERENCE;
    const seg = {
      ...r,
      color: RAMP[i % RAMP.length]!,
      dasharray: `${Math.max(dash - GAP, 0)} ${CIRCUMFERENCE - dash + GAP}`,
      dashoffset: -cumulative,
    };
    cumulative += dash;
    return seg;
  });

  return (
    <div className="flex flex-wrap items-center justify-center gap-6">
      <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
            style={{ stroke: "var(--color-border)" }}
          />
          {segments.map(
            (s) =>
              s.count > 0 && (
                <circle
                  key={s.label}
                  cx={SIZE / 2}
                  cy={SIZE / 2}
                  r={RADIUS}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={STROKE}
                  strokeDasharray={s.dasharray}
                  strokeDashoffset={s.dashoffset}
                  strokeLinecap="butt"
                  transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
                >
                  <title>{`Level ${s.label}: ${s.count} (${total === 0 ? 0 : Math.round((s.count / total) * 100)}%)`}</title>
                </circle>
              ),
          )}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold text-neutral-100">{total}</span>
          <span className="text-[10px] tracking-wide text-neutral-500 uppercase">Characters</span>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        {rows.map((r, i) => (
          <div key={r.label} className="flex items-center gap-2 text-xs">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: RAMP[i % RAMP.length] }} />
            <span className="w-12 shrink-0 text-neutral-400">Lvl {r.label}</span>
            <span className="text-neutral-500 tabular-nums">{r.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
