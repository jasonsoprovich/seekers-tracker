"use client";

import { useMemo, useState } from "react";

import type { RaidLoot } from "@/lib/epgp/raids";

const TIER_RANK: Record<string, number> = { "High Bid": 4, "Medium Bid": 3, "Low Bid": 2, "Alt Loot": 1 };

const STATUS_CLASS: Record<RaidLoot["bids"][number]["status"], string> = {
  won: "text-emerald-400",
  lost: "text-neutral-500",
  active: "text-amber-400",
  retracted: "text-neutral-600 line-through",
};

// The raid detail page's Loot table, with each item row expandable to the
// full bid list + priorities behind the win (post-live-test-1 LT-18) — so
// members can review a past raid's loot decisions without leaving the page.
export function RaidLootTable({ loot, timeZone }: { loot: RaidLoot[]; timeZone: string }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const timeFmt = useMemo(
    () => new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit" }),
    [timeZone],
  );

  function toggle(id: number) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-border text-[11px] uppercase tracking-wide text-neutral-500">
          <tr>
            <th className="px-3 py-2 font-medium">Item</th>
            <th className="px-3 py-2 font-medium">Winner</th>
            <th className="px-3 py-2 font-medium">Bid</th>
            <th className="px-3 py-2 font-medium text-right">GP</th>
            <th className="px-3 py-2 font-medium">Time</th>
            <th className="px-3 py-2 font-medium">Note</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {loot.map((l) => {
            const isOpen = open.has(l.lootEventId);
            const hasBids = l.bids.length > 0;
            const ranked = [...l.bids].sort((a, b) => {
              if (a.status === "won" && b.status !== "won") return -1;
              if (b.status === "won" && a.status !== "won") return 1;
              const rank = (TIER_RANK[b.tier] ?? 0) - (TIER_RANK[a.tier] ?? 0);
              if (rank !== 0) return rank;
              return (b.prioritySnapshot ?? -Infinity) - (a.prioritySnapshot ?? -Infinity);
            });
            return (
              <tr key={l.lootEventId}>
                <td colSpan={6} className="p-0">
                  <button
                    type="button"
                    onClick={() => hasBids && toggle(l.lootEventId)}
                    className={`flex w-full items-center px-3 py-2 text-left ${hasBids ? "hover:bg-neutral-900/40" : "cursor-default"}`}
                  >
                    <span className="flex-[2] font-medium">
                      {hasBids && <span className="mr-1 text-[10px] text-neutral-500">{isOpen ? "▾" : "▸"}</span>}
                      {l.itemName}
                      {hasBids && <span className="ml-2 text-[11px] font-normal text-neutral-500">{l.bids.length} bids</span>}
                    </span>
                    <span className="flex-[2]">{l.winnerName ?? <span className="text-neutral-600">—</span>}</span>
                    <span className="flex-1 text-neutral-400">{l.tier ?? "—"}</span>
                    <span className="w-14 text-right tabular-nums">{l.gp !== null ? Math.round(l.gp) : "—"}</span>
                    <span className="w-24 pl-3 tabular-nums text-neutral-400">{timeFmt.format(l.occurredAt)}</span>
                    <span className="flex-[2] pl-3 text-neutral-500">{l.note ?? ""}</span>
                  </button>

                  {isOpen && (
                    <div className="border-t border-border bg-neutral-950/40 px-3 py-2 pl-8">
                      {ranked.length === 0 ? (
                        <p className="text-xs text-neutral-500">No bids recorded for this drop.</p>
                      ) : (
                        <table className="w-full max-w-lg text-left text-xs">
                          <thead className="text-[10px] uppercase tracking-wide text-neutral-600">
                            <tr>
                              <th className="py-1 pr-4 font-medium">Character</th>
                              <th className="py-1 pr-4 font-medium">Bid</th>
                              <th className="py-1 pr-4 font-medium">Priority</th>
                              <th className="py-1 font-medium">Result</th>
                            </tr>
                          </thead>
                          <tbody>
                            {ranked.map((b, j) => (
                              <tr key={j}>
                                <td className="py-1 pr-4 text-neutral-300">{b.characterName}</td>
                                <td className="py-1 pr-4 text-neutral-400">{b.tier}</td>
                                <td className="py-1 pr-4 tabular-nums text-neutral-400">
                                  {b.prioritySnapshot != null ? b.prioritySnapshot.toFixed(4) : "—"}
                                </td>
                                <td className={`py-1 capitalize ${STATUS_CLASS[b.status]}`}>{b.status}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
