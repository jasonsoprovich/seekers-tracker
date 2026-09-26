"use client";

import { SortableTh, useTableSort } from "@/components/ui/table-sort";
import { guildDateTime } from "@/lib/guild-timezone";

export type BankAuditLogRow = {
  id: number;
  holderCharacterId: number;
  holderName: string;
  itemName: string;
  action: "create" | "update" | "delete";
  source: "manual" | "sync";
  changedAt: Date;
  changedByName: string | null;
  before: unknown;
  after: unknown;
};

// Fields worth showing in the trail, in display order — mirrors
// AuditLogTable's own FIELDS/describe() pattern for the EP/GP ledger.
const FIELDS: { key: string; label: string }[] = [
  { key: "container", label: "container" },
  { key: "slotIndex", label: "slot" },
  { key: "quantity", label: "qty" },
  { key: "status", label: "status" },
  { key: "note", label: "note" },
];

function fmt(value: unknown): string {
  if (value === null || value === undefined || value === "") return "∅";
  return String(value);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

// A create/delete shows the row's key fields; an update shows only what
// actually moved, "field: old → new".
function describe(row: BankAuditLogRow): { field: string; text: string }[] {
  const before = asRecord(row.before);
  const after = asRecord(row.after);

  if (row.action === "create") {
    return FIELDS.filter((f) => after?.[f.key] != null && after[f.key] !== "").map((f) => ({ field: f.label, text: fmt(after![f.key]) }));
  }
  if (row.action === "delete") {
    return FIELDS.filter((f) => before?.[f.key] != null && before[f.key] !== "").map((f) => ({ field: f.label, text: fmt(before![f.key]) }));
  }
  const changed = FIELDS.filter((f) => fmt(before?.[f.key]) !== fmt(after?.[f.key])).map((f) => ({
    field: f.label,
    text: `${fmt(before?.[f.key])} → ${fmt(after?.[f.key])}`,
  }));
  return changed.length > 0 ? changed : [{ field: "", text: "no visible field changed" }];
}

const ACTION_STYLE: Record<BankAuditLogRow["action"], string> = {
  create: "text-emerald-400",
  update: "text-amber-400",
  delete: "text-red-400",
};

const SOURCE_LABEL: Record<BankAuditLogRow["source"], string> = {
  sync: "Officer app sync",
  manual: "Manual entry",
};

type Col = "when" | "officer" | "source" | "action" | "holder" | "item";

// The item-level history behind /bank's numbers — every add/remove/change
// a real officer-app sync (src/lib/bank/sync.ts's applySync) or a manual
// add/edit/delete (src/lib/bank/holdings.ts) has made, one row per item.
// Deliberately its own table/query, not the EP/GP ledger's AuditLogTable
// or the admin-only System Log — see bank_audit_log's schema comment for
// why. Read-only, member-visible, same transparency posture as the EPGP
// ledger's Audit Trail tab.
export function BankAuditLogTable({ rows }: { rows: BankAuditLogRow[] }) {
  const { sorted, sort, toggle } = useTableSort<BankAuditLogRow, Col>(rows, {
    when: (r) => r.changedAt.getTime(),
    officer: (r) => r.changedByName,
    source: (r) => r.source,
    action: (r) => r.action,
    holder: (r) => r.holderName,
    item: (r) => r.itemName,
  });

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[980px] text-left text-sm">
        <thead>
          <tr className="border-b border-border bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
            <SortableTh className="px-3 py-2" label="When" sortKey="when" sort={sort} onSort={toggle} />
            <SortableTh className="px-3 py-2" label="Officer" sortKey="officer" sort={sort} onSort={toggle} />
            <SortableTh className="px-3 py-2" label="Source" sortKey="source" sort={sort} onSort={toggle} />
            <SortableTh className="px-3 py-2" label="Action" sortKey="action" sort={sort} onSort={toggle} />
            <SortableTh className="px-3 py-2" label="Holder" sortKey="holder" sort={sort} onSort={toggle} />
            <SortableTh className="px-3 py-2" label="Item" sortKey="item" sort={sort} onSort={toggle} />
            <th className="px-3 py-2 font-medium">Change</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {sorted.map((r) => {
            const parts = describe(r);
            return (
              <tr key={r.id} className="align-top hover:bg-neutral-900/40">
                <td className="px-3 py-2 whitespace-nowrap text-neutral-400">{guildDateTime(r.changedAt)}</td>
                <td className="px-3 py-2 font-medium">{r.changedByName ?? "—"}</td>
                <td className="px-3 py-2 text-neutral-400">{SOURCE_LABEL[r.source]}</td>
                <td className={`px-3 py-2 font-medium ${ACTION_STYLE[r.action]}`}>{r.action}</td>
                <td className="px-3 py-2">{r.holderName}</td>
                <td className="px-3 py-2">{r.itemName}</td>
                <td className="px-3 py-2 text-neutral-300">
                  <div className="flex flex-col gap-0.5">
                    {parts.map((p, i) => (
                      <span key={i}>
                        {p.field && <span className="text-neutral-500">{p.field}: </span>}
                        {p.text}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            );
          })}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-6 text-center text-neutral-500">
                No bank changes recorded for this filter.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
