import { ledgerDate } from "@/lib/format-date";
import type { BidHistoryRow } from "@/lib/epgp/ledger-list";

const STATUS_CLASSES: Record<BidHistoryRow["status"], string> = {
  won: "text-emerald-400",
  lost: "text-neutral-500",
  active: "text-amber-400",
  retracted: "text-neutral-600 line-through",
};

// Read-only — bids are written exclusively through the officer app's
// "Determine Winner" flow (POST /api/officer/bids); there's no edit/delete
// action for a bid row, so unlike LedgerTable/BankBrowseTable this table
// has no canManage prop and no Actions column.
export function BidHistoryTable({ rows }: { rows: BidHistoryRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead>
          <tr className="border-b border-border bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
            <th className="px-3 py-2 font-medium">Date</th>
            <th className="px-3 py-2 font-medium">Item</th>
            <th className="px-3 py-2 font-medium">Character</th>
            <th className="px-3 py-2 font-medium">Tier</th>
            <th className="px-3 py-2 font-medium">Priority</th>
            <th className="px-3 py-2 font-medium">Result</th>
            <th className="px-3 py-2 font-medium">Note</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.id} className="hover:bg-neutral-900/40">
              <td className="px-3 py-2 text-neutral-400">{ledgerDate(r.occurredAt)}</td>
              <td className="px-3 py-2 font-medium">{r.itemName}</td>
              <td className="px-3 py-2 text-neutral-400">{r.characterName}</td>
              <td className="px-3 py-2 text-neutral-400">{r.tier}</td>
              <td className="px-3 py-2 text-neutral-500">{r.prioritySnapshot?.toFixed(2) ?? "—"}</td>
              <td className={`px-3 py-2 font-medium capitalize ${STATUS_CLASSES[r.status]}`}>{r.status}</td>
              <td className="px-3 py-2 text-neutral-500">{r.note ?? "—"}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-6 text-center text-neutral-500">
                No bids match this search.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
