import { CHAR_CLASSES, classColor } from "@/lib/eq/enums";

import { VerticalBarChart, type Bar } from "./VerticalBarChart";

export interface ClassCompositionRow {
  id: number;
  abbr: string;
  main: number;
  alt: number;
}

// Vertical column per class, colored with the class's own hue (same palette
// pq-companion uses for DPS/player-tracker class identity — see
// lib/eq/enums.ts CLASS_COLORS) so a class reads as the same color across
// both apps. Main/alt split rides the same hue as two shades (main at full
// opacity, alt dimmed) rather than a second series color, since the bar's
// hue is already spoken for by class identity.
export function ClassBarChart({ rows }: { rows: ClassCompositionRow[] }) {
  const bars: Bar[] = rows.map((r) => {
    const color = classColor(r.id);
    return {
      key: String(r.id),
      label: r.abbr,
      labelTitle: CHAR_CLASSES.find((c) => c.id === r.id)?.name,
      total: r.main + r.alt,
      segments: [
        { value: r.main, color, title: `${r.abbr} mains: ${r.main}` },
        { value: r.alt, color, opacity: 0.4, title: `${r.abbr} alts: ${r.alt}` },
      ],
    };
  });

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
      <VerticalBarChart bars={bars} />
    </div>
  );
}
