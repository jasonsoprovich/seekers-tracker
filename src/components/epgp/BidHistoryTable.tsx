"use client";

import { ledgerDate } from "@/lib/format-date";
import { SortableTh, useTableSort } from "@/components/ui/table-sort";
import type { BidHistoryRow } from "@/lib/epgp/ledger-list";

const STATUS_CLASSES: Record<BidHistoryRow["status"], string> = {
  won: "text-emerald-400",
  lost: "text-neutral-500",
  active: "text-amber-400",
  retracted: "text-neutral-600 line-through",
};

type Col = "date" | "item" | "character" | "bid" | "recordedPriority" | "currentPriority" | "result";

function fmtPriority(p: number | null): string {
  return p?.toFixed(4) ?? "—";
}

// Read-only — bids are written exclusively through the officer app's
// "Determine Winner" flow (POST /api/officer/bids); there's no edit/delete
// action for a bid row, so unlike LedgerTable/BankBrowseTable this table
// has no canManage prop and no Actions column. Columns are click-to-sort
// (LT-19); default is newest-first, as it arrives.
//
// Two priority numbers (Phase 7, "Bid-History Priority Clarity"): the
// stored snapshot is calculated when the round was RECORDED, not
// necessarily at the raw tell's own timestamp — "Priority" alone
// overstated how precise/current that number is. "Recorded PR" is that
// same stored value, relabeled with an explanatory title; "Current PR" is
// the live priority of whoever the bid is durably tied to today
// (bids.playerId, captured at bid time — see ledger-list.ts/schema.ts),
// so a leader reviewing an old dispute can see both "what it was" and
// "what it is now" without confusing the two.
export function BidHistoryTable({ rows }: { rows: BidHistoryRow[] }) {
  const { sorted, sort, toggle } = useTableSort<BidHistoryRow, Col>(rows, {
    date: (r) => r.occurredAt.getTime(),
    item: (r) => r.itemName,
    character: (r) => r.characterName,
    bid: (r) => r.tier,
    recordedPriority: (r) => r.prioritySnapshot,
    currentPriority: (r) => r.currentPriority,
    result: (r) => r.status,
  });

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead>
          <tr className="border-b border-border bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
            <SortableTh className="px-3 py-2" label="Date" sortKey="date" sort={sort} onSort={toggle} />
            <SortableTh className="px-3 py-2" label="Item" sortKey="item" sort={sort} onSort={toggle} />
            <SortableTh className="px-3 py-2" label="Character" sortKey="character" sort={sort} onSort={toggle} />
            <SortableTh className="px-3 py-2" label="Bid" sortKey="bid" sort={sort} onSort={toggle} />
            {/* Desktop: two separate columns. Mobile: one combined "Priority"
                cell below (task 7.4) — showing both this narrow keeps the
                table from needing even more horizontal scroll on a phone. */}
            <SortableTh
              className="hidden px-3 py-2 sm:table-cell"
              label="Recorded PR"
              title="Priority Rating captured when this round was recorded — not necessarily at the exact moment of the tell."
              sortKey="recordedPriority"
              sort={sort}
              onSort={toggle}
            />
            <SortableTh
              className="hidden px-3 py-2 sm:table-cell"
              label="Current PR"
              title="This bidder's live Priority Rating today, from the current standings."
              sortKey="currentPriority"
              sort={sort}
              onSort={toggle}
            />
            <th className="px-3 py-2 font-medium sm:hidden" title="Recorded PR (at bid time) over Current PR (today)">
              Priority
            </th>
            <SortableTh className="px-3 py-2" label="Result" sortKey="result" sort={sort} onSort={toggle} />
            <th className="px-3 py-2 font-medium">Note</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {sorted.map((r) => (
            <tr key={r.id} className="hover:bg-neutral-900/40">
              {/* Bid history is always parser-origin (loot_events), so its
                  occurredAt is a real timestamp — render in guild tz (LT-10). */}
              <td className="px-3 py-2 text-neutral-400">{ledgerDate(r.occurredAt, "parse")}</td>
              <td className="px-3 py-2 font-medium">{r.itemName}</td>
              <td className="px-3 py-2 text-neutral-400">{r.characterName}</td>
              <td className="px-3 py-2 text-neutral-400">{r.tier}</td>
              <td className="hidden px-3 py-2 text-neutral-500 sm:table-cell">{fmtPriority(r.prioritySnapshot)}</td>
              <td className="hidden px-3 py-2 text-neutral-500 sm:table-cell">{fmtPriority(r.currentPriority)}</td>
              <td className="px-3 py-2 text-neutral-500 sm:hidden">
                <div className="flex flex-col leading-tight">
                  <span>{fmtPriority(r.prioritySnapshot)}</span>
                  <span className="text-xs text-neutral-600">now {fmtPriority(r.currentPriority)}</span>
                </div>
              </td>
              <td className={`px-3 py-2 font-medium capitalize ${STATUS_CLASSES[r.status]}`}>{r.status}</td>
              <td className="px-3 py-2 text-neutral-500">{r.note ?? "—"}</td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={8} className="px-3 py-6 text-center text-neutral-500">
                No bids match this search.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
