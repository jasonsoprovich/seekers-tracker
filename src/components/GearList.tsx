import { GEAR_SLOTS } from "@/lib/gear";

export interface GearListRow {
  slot: string;
  itemName: string;
}

// Every worn slot shown, even when empty — same "show the gap" pattern as
// the dashboard's class composition chart, and the most useful read for a
// gear list ("what are they still missing").
export function GearList({ rows }: { rows: GearListRow[] }) {
  const bySlot = new Map(rows.map((r) => [r.slot, r.itemName]));

  return (
    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
      {GEAR_SLOTS.map((s) => {
        const itemName = bySlot.get(s.key);
        return (
          <div
            key={s.key}
            className="flex items-center justify-between gap-3 rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2"
          >
            <span className="shrink-0 text-xs font-medium text-neutral-500">{s.label}</span>
            <span className={`truncate text-sm ${itemName ? "text-neutral-100" : "text-neutral-600 italic"}`}>
              {itemName ?? "empty"}
            </span>
          </div>
        );
      })}
    </div>
  );
}
