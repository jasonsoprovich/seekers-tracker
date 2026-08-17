import { StatTile } from "@/components/dashboard/StatTile";
import { Card } from "@/components/ui/Card";
import type { Attributes, DerivedStats, Resists } from "@/lib/eqstat";

const ATTR_LABELS: { key: keyof Attributes; label: string }[] = [
  { key: "str", label: "STR" },
  { key: "sta", label: "STA" },
  { key: "agi", label: "AGI" },
  { key: "dex", label: "DEX" },
  { key: "wis", label: "WIS" },
  { key: "int", label: "INT" },
  { key: "cha", label: "CHA" },
];

const RESIST_LABELS: { key: keyof Resists; label: string }[] = [
  { key: "mr", label: "Magic" },
  { key: "cr", label: "Cold" },
  { key: "fr", label: "Fire" },
  { key: "dr", label: "Disease" },
  { key: "pr", label: "Poison" },
];

// §8 Phase 3 / task 18: gear-only derived stats — no buffs, no AA, no spell
// effects (see src/lib/eqstat/formulas.ts's scope note). base is the
// character's captured base attributes; stats is the full computed sheet.
export function StatSheet({ base, stats }: { base: Attributes; stats: DerivedStats }) {
  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-neutral-500">
        Computed from base attributes + worn gear only — buffs, AAs, and spell effects aren&apos;t included.
      </p>

      <div className="grid grid-cols-3 gap-3">
        <StatTile label="HP" value={stats.hp} />
        <StatTile label="Mana" value={stats.mana} />
        <StatTile label="AC" value={stats.ac.displayedAC} />
      </div>

      <section>
        <h3 className="text-sm font-semibold text-neutral-300">Attributes</h3>
        <div className="mt-2 overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-neutral-900/60 text-left text-xs tracking-wider text-neutral-500 uppercase">
                <th className="px-3 py-2 font-medium">Stat</th>
                <th className="px-3 py-2 text-right font-medium">Base</th>
                <th className="px-3 py-2 text-right font-medium">Gear</th>
                <th className="px-3 py-2 text-right font-medium">Effective</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {ATTR_LABELS.map((a) => (
                <tr key={a.key}>
                  <td className="px-3 py-1.5 text-neutral-400">{a.label}</td>
                  <td className="px-3 py-1.5 text-right text-neutral-400 tabular-nums">{base[a.key]}</td>
                  <td className="px-3 py-1.5 text-right text-neutral-400 tabular-nums">
                    {stats.gear[a.key] > 0 ? `+${stats.gear[a.key]}` : stats.gear[a.key]}
                  </td>
                  <td className="px-3 py-1.5 text-right font-medium text-neutral-100 tabular-nums">
                    {stats.attributes[a.key]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold text-neutral-300">Resists</h3>
        <div className="mt-2 grid grid-cols-5 gap-2">
          {RESIST_LABELS.map((r) => (
            <Card key={r.key} className="px-2 py-2 text-center">
              <p className="text-[10px] tracking-wider text-neutral-500 uppercase">{r.label}</p>
              <p className="mt-0.5 text-lg font-semibold text-neutral-100 tabular-nums">{stats.resists[r.key]}</p>
            </Card>
          ))}
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold text-neutral-300">AC Breakdown</h3>
        <Card className="mt-2 flex gap-4 px-4 py-3 text-sm">
          <div>
            <p className="text-xs text-neutral-500">Avoidance</p>
            <p className="font-medium text-neutral-100 tabular-nums">{stats.ac.avoidance}</p>
          </div>
          <div>
            <p className="text-xs text-neutral-500">Mitigation</p>
            <p className="font-medium text-neutral-100 tabular-nums">{stats.ac.mitigation}</p>
          </div>
          <div>
            <p className="text-xs text-neutral-500">Displayed AC</p>
            <p className="font-medium text-neutral-100 tabular-nums">{stats.ac.displayedAC}</p>
          </div>
        </Card>
      </section>
    </div>
  );
}
