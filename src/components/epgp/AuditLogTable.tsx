import { ledgerDate } from "@/lib/format-date";

export type AuditLogRow = {
  id: number;
  ledgerType: "ep" | "gp";
  ledgerId: number;
  action: "create" | "update" | "delete";
  changedAt: Date;
  changedByName: string | null;
  before: unknown;
  after: unknown;
};

// Fields worth showing in the trail, in display order. Everything else on
// the row (ids, player_id, the points_nominal/awarded mirrors, cap/source
// bookkeeping, source_key) is noise for "what did an officer change".
const FIELDS: Record<"ep" | "gp", { key: string; label: string; kind?: "date" }[]> = {
  ep: [
    { key: "occurredAt", label: "date", kind: "date" },
    { key: "activity", label: "activity" },
    { key: "points", label: "points" },
    { key: "zone", label: "zone" },
    { key: "note", label: "note" },
  ],
  gp: [
    { key: "occurredAt", label: "date", kind: "date" },
    { key: "itemName", label: "item" },
    { key: "tier", label: "tier" },
    { key: "points", label: "points" },
    { key: "note", label: "note" },
  ],
};

function fmt(value: unknown, kind?: "date"): string {
  if (value === null || value === undefined || value === "") return "∅";
  // ledger dates are stored at UTC midnight — see @/lib/format-date.
  if (kind === "date") return ledgerDate(value as string | number);
  return String(value);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

// A create/delete shows the row's key fields; an update shows only what
// actually moved, "field: old → new".
function describe(row: AuditLogRow): { field: string; text: string }[] {
  const fields = FIELDS[row.ledgerType];
  const before = asRecord(row.before);
  const after = asRecord(row.after);

  if (row.action === "create") {
    return fields.filter((f) => after?.[f.key] != null && after[f.key] !== "").map((f) => ({ field: f.label, text: fmt(after![f.key], f.kind) }));
  }
  if (row.action === "delete") {
    return fields.filter((f) => before?.[f.key] != null && before[f.key] !== "").map((f) => ({ field: f.label, text: fmt(before![f.key], f.kind) }));
  }
  // update
  const changed = fields
    .filter((f) => fmt(before?.[f.key], f.kind) !== fmt(after?.[f.key], f.kind))
    .map((f) => ({ field: f.label, text: `${fmt(before?.[f.key], f.kind)} → ${fmt(after?.[f.key], f.kind)}` }));
  return changed.length > 0 ? changed : [{ field: "", text: "no visible field changed" }];
}

const ACTION_STYLE: Record<AuditLogRow["action"], string> = {
  create: "text-emerald-400",
  update: "text-amber-400",
  delete: "text-red-400",
};

// Read-only — edit/delete/add of ep_ledger/gp_ledger rows happens on the EP
// Ledger / GP Ledger tabs; this tab is purely the trail those actions leave
// via recordLedgerChange (src/lib/epgp/ledger-audit.ts).
export function AuditLogTable({ rows, characterNames }: { rows: AuditLogRow[]; characterNames: Map<number, string> }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[880px] text-left text-sm">
        <thead>
          <tr className="border-b border-border bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
            <th className="px-3 py-2 font-medium">When</th>
            <th className="px-3 py-2 font-medium">Officer</th>
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium">Action</th>
            <th className="px-3 py-2 font-medium">Character</th>
            <th className="px-3 py-2 font-medium">Change</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => {
            const snapshot = asRecord(r.before) ?? asRecord(r.after);
            const charId = snapshot?.characterId;
            const characterName = typeof charId === "number" ? (characterNames.get(charId) ?? `#${charId}`) : "—";
            const parts = describe(r);
            return (
              <tr key={r.id} className="align-top hover:bg-neutral-900/40">
                <td className="px-3 py-2 whitespace-nowrap text-neutral-400">{r.changedAt.toLocaleString()}</td>
                <td className="px-3 py-2 font-medium">{r.changedByName ?? "—"}</td>
                <td className="px-3 py-2 uppercase text-neutral-400">{r.ledgerType}</td>
                <td className={`px-3 py-2 font-medium ${ACTION_STYLE[r.action]}`}>{r.action}</td>
                <td className="px-3 py-2">{characterName}</td>
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
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="px-3 py-6 text-center text-neutral-500">
                No ledger edits recorded yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
