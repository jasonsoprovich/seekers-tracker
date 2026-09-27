"use client";

import { Fragment, useState } from "react";

import { SortableTh, useTableSort } from "@/components/ui/table-sort";
import { guildDateTime } from "@/lib/guild-timezone";

export type BankAuditLogRow = {
  id: number;
  holderCharacterId: number;
  holderName: string;
  itemName: string;
  action: "create" | "update" | "delete" | "verify";
  source: "manual" | "sync";
  changedAt: Date;
  changedByName: string | null;
  before: unknown;
  after: unknown;
  note: string | null;
  batchId: string | null;
};

// Mirrors src/lib/bank/audit.ts's BankAuditBatch — one line per real batch
// (a sync, or a bulk "remove unverified item" pass) or per one-off event.
export type BankAuditLogBatch = {
  batchId: string | null;
  changedAt: Date;
  holderCharacterId: number;
  holderName: string;
  source: "manual" | "sync";
  changedByName: string | null;
  summary: { created: number; updated: number; removed: number; verified: number };
  rows: BankAuditLogRow[];
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

// A create/delete shows the row's key fields; an update/verify shows only
// what actually moved, "field: old → new".
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
  verify: "text-sky-400",
};

// Guild-bank-appropriate language for officers, not raw CRUD verbs — the
// stored `action` value (schema.ts's bank_audit_log.action enum) is
// unchanged, this is a display-only relabel.
const ACTION_LABEL: Record<BankAuditLogRow["action"], string> = {
  create: "Add",
  update: "Edit",
  delete: "Remove",
  verify: "Verify",
};

const SOURCE_LABEL: Record<BankAuditLogRow["source"], string> = {
  sync: "Officer app sync",
  manual: "Manual entry",
};

function summaryLine(b: BankAuditLogBatch): string {
  if (b.rows.length <= 1) {
    const row = b.rows[0];
    return row ? row.itemName : "";
  }
  const parts: string[] = [];
  if (b.summary.verified > 0) parts.push(`${b.summary.verified} verified from sheet`);
  if (b.summary.created > 0) parts.push(`${b.summary.created} added`);
  if (b.summary.updated > 0) parts.push(`${b.summary.updated} edited`);
  if (b.summary.removed > 0) parts.push(`${b.summary.removed} removed`);
  return parts.join(" · ") || `${b.rows.length} item(s)`;
}

type Col = "when" | "officer" | "source" | "holder";

// The item-level history behind /bank's numbers — every add/remove/change
// a real officer-app sync (src/lib/bank/sync.ts's applySync) or a manual
// add/edit/delete (src/lib/bank/holdings.ts) has made, one row per item.
// Deliberately its own table/query, not the EP/GP ledger's AuditLogTable
// or the admin-only System Log — see bank_audit_log's schema comment for
// why. Officer/leader/admin-only as of 2026-09-27 (epgp.bank.audit.view —
// gated server-side in bank/page.tsx, not here).
//
// Rows from one sync (or one bulk "remove unverified item" pass) collapse
// to a single summary line, expandable to the real per-item rows — 2026-
// 09-27 officer feedback: adding/removing a whole bag "gets messy ... its
// just a lot of entries," while still being "correct ... and is tracking
// what actually happened." The correct per-item trail is unchanged; only
// its default presentation is collapsed. A one-off manual event (batchId
// null, exactly one row) shows flat, same as before this change.
export function BankAuditLogTable({ batches }: { batches: BankAuditLogBatch[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { sorted, sort, toggle } = useTableSort<BankAuditLogBatch, Col>(batches, {
    when: (b) => b.changedAt.getTime(),
    officer: (b) => b.changedByName,
    source: (b) => b.source,
    holder: (b) => b.holderName,
  });

  function keyOf(b: BankAuditLogBatch, i: number): string {
    return b.batchId ?? `row:${b.rows[0]?.id ?? i}`;
  }

  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[980px] text-left text-sm">
        <thead>
          <tr className="border-b border-border bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
            <SortableTh className="px-3 py-2" label="When" sortKey="when" sort={sort} onSort={toggle} />
            <SortableTh className="px-3 py-2" label="Officer" sortKey="officer" sort={sort} onSort={toggle} />
            <SortableTh className="px-3 py-2" label="Source" sortKey="source" sort={sort} onSort={toggle} />
            <SortableTh className="px-3 py-2" label="Holder" sortKey="holder" sort={sort} onSort={toggle} />
            <th className="px-3 py-2 font-medium">Summary</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {sorted.map((b, i) => {
            const key = keyOf(b, i);
            const isBatch = b.rows.length > 1;
            const isOpen = expanded.has(key);
            return (
              <Fragment key={key}>
                <tr
                  className={`align-top hover:bg-neutral-900/40 ${isBatch ? "cursor-pointer" : ""}`}
                  onClick={isBatch ? () => toggleExpanded(key) : undefined}
                >
                  <td className="px-3 py-2 whitespace-nowrap text-neutral-400">{guildDateTime(b.changedAt)}</td>
                  <td className="px-3 py-2 font-medium">{b.changedByName ?? "—"}</td>
                  <td className="px-3 py-2 text-neutral-400">{SOURCE_LABEL[b.source]}</td>
                  <td className="px-3 py-2">{b.holderName}</td>
                  <td className="px-3 py-2 text-neutral-300">
                    {isBatch ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="text-neutral-500">{isOpen ? "▾" : "▸"}</span>
                        {summaryLine(b)}
                      </span>
                    ) : b.rows.length === 1 ? (
                      <div className="flex flex-col gap-0.5">
                        <span>
                          <span className={`font-medium ${ACTION_STYLE[b.rows[0].action]}`}>{ACTION_LABEL[b.rows[0].action]}</span>{" "}
                          {b.rows[0].itemName}
                        </span>
                        {describe(b.rows[0]).map((p, j) => (
                          <span key={j} className="text-xs">
                            {p.field && <span className="text-neutral-500">{p.field}: </span>}
                            {p.text}
                          </span>
                        ))}
                        {b.rows[0].note && <span className="text-xs text-neutral-500">Note: {b.rows[0].note}</span>}
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
                {isBatch && isOpen && (
                  <tr key={`${key}-detail`}>
                    <td colSpan={5} className="border-t-0 bg-neutral-950/60 p-0">
                      <table className="w-full text-left text-xs">
                        <tbody className="divide-y divide-border/60">
                          {b.rows.map((r) => {
                            const parts = describe(r);
                            return (
                              <tr key={r.id} className="align-top">
                                <td className="w-24 px-3 py-1.5 font-medium">
                                  <span className={ACTION_STYLE[r.action]}>{ACTION_LABEL[r.action]}</span>
                                </td>
                                <td className="px-3 py-1.5">{r.itemName}</td>
                                <td className="px-3 py-1.5 text-neutral-400">
                                  <div className="flex flex-col gap-0.5">
                                    {parts.map((p, j) => (
                                      <span key={j}>
                                        {p.field && <span className="text-neutral-500">{p.field}: </span>}
                                        {p.text}
                                      </span>
                                    ))}
                                  </div>
                                </td>
                                <td className="px-3 py-1.5 text-neutral-500">{r.note ?? ""}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={5} className="px-3 py-6 text-center text-neutral-500">
                No bank changes recorded for this filter.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
