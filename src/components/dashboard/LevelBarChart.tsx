import { VerticalBarChart, type Bar } from "./VerticalBarChart";

export interface LevelBracketRow {
  label: string;
  count: number;
}

// One hue, light -> dark, low bracket to level cap — sequential ramp
// (Tailwind's sky steps) rather than a categorical palette, since level
// brackets are ordinal (magnitude, not identity): darker reads as "further
// along," matching the dataviz convention of more-is-darker.
const RAMP = ["#bae6fd", "#7dd3fc", "#38bdf8", "#0ea5e9", "#0284c7", "#0369a1", "#075985"];

export function LevelBarChart({ rows }: { rows: LevelBracketRow[] }) {
  const bars: Bar[] = rows.map((r, i) => ({
    key: r.label,
    label: r.label,
    labelTitle: `Level ${r.label}`,
    total: r.count,
    segments: [{ value: r.count, color: RAMP[i % RAMP.length]!, title: `Level ${r.label}: ${r.count}` }],
  }));

  return <VerticalBarChart bars={bars} />;
}
