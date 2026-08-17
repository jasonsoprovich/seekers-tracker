"use client";

import { useState } from "react";

import { GEAR_SLOTS } from "@/lib/gear";
import type { ItemStatLine } from "@/lib/eqstat";

export interface GearListRow {
  slot: string;
  itemName: string;
  itemId: number;
  stats: ItemStatLine[];
}

function ItemTooltip({ row, pinned }: { row: GearListRow; pinned: boolean }) {
  return (
    <div
      className={`${pinned ? "block" : "hidden group-hover:block"} absolute top-full left-0 z-30 mt-1 w-64 rounded-lg border border-border bg-neutral-950 p-3 text-left shadow-xl`}
    >
      <p className="text-sm font-semibold text-neutral-100">{row.itemName}</p>
      {row.stats.length === 0 ? (
        <p className="mt-1 text-xs text-neutral-500">No stat data on file for this item.</p>
      ) : (
        <dl className="mt-1.5 flex flex-col gap-0.5">
          {row.stats.map((line) => (
            <div key={line.label} className="flex justify-between gap-3 text-xs">
              <dt className="shrink-0 text-neutral-500">{line.label}</dt>
              <dd className="text-right text-neutral-200 tabular-nums">{line.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

// Hover-stat cards, similar in spirit to Quarmy's item popover but
// text-only — this app doesn't bundle item icon art (see item-icons.ts), so
// no icon image is rendered. Hover shows the card on desktop (pure CSS);
// clicking pins it open for touch devices, closed by clicking outside or
// the item again.
export function GearList({ rows }: { rows: GearListRow[] }) {
  const [pinnedSlot, setPinnedSlot] = useState<string | null>(null);
  const bySlot = new Map(rows.map((r) => [r.slot, r]));

  return (
    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
      {pinnedSlot && (
        <button
          type="button"
          aria-hidden
          tabIndex={-1}
          onClick={() => setPinnedSlot(null)}
          className="fixed inset-0 z-20 cursor-default"
        />
      )}
      {GEAR_SLOTS.map((s) => {
        const row = bySlot.get(s.key);
        const pinned = pinnedSlot === s.key;
        return (
          <div key={s.key} className="group relative">
            <button
              type="button"
              disabled={!row}
              onClick={() => row && setPinnedSlot(pinned ? null : s.key)}
              className={`flex w-full items-center justify-between gap-3 rounded-md border border-border bg-panel px-3 py-2 text-left ${
                row ? "cursor-pointer hover:border-neutral-600" : "cursor-default"
              }`}
            >
              <span className="shrink-0 text-xs font-medium text-neutral-500">{s.label}</span>
              <span className={`truncate text-sm ${row ? "text-neutral-100" : "text-neutral-600 italic"}`}>
                {row?.itemName ?? "empty"}
              </span>
            </button>
            {row && <ItemTooltip row={row} pinned={pinned} />}
          </div>
        );
      })}
    </div>
  );
}
