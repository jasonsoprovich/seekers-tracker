export type AuditLogRow = {
  id: number;
  ledgerType: "ep" | "gp";
  ledgerId: number;
  action: "update" | "delete";
  changedAt: Date;
  changedByName: string | null;
  before: unknown;
  after: unknown;
};

function summarize(snapshot: unknown, ledgerType: "ep" | "gp"): string {
  if (!snapshot || typeof snapshot !== "object") return "—";
  const s = snapshot as Record<string, unknown>;
  return ledgerType === "ep" ? `${s.activity} · ${s.points} pts` : `${s.itemName ?? "(no item)"} · ${s.tier} · ${s.points} pts`;
}

// Read-only — edit/delete of ep_ledger/gp_ledger rows happens on the EP
// Ledger/GP Ledger tabs; this tab is purely the trail those actions leave
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
            <th className="px-3 py-2 font-medium">Before</th>
            <th className="px-3 py-2 font-medium">After</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => {
            const beforeChar = (r.before as Record<string, unknown> | null)?.characterId;
            const characterName = typeof beforeChar === "number" ? (characterNames.get(beforeChar) ?? `#${beforeChar}`) : "—";
            return (
              <tr key={r.id} className="hover:bg-neutral-900/40">
                <td className="px-3 py-2 text-neutral-400">{r.changedAt.toLocaleString()}</td>
                <td className="px-3 py-2 font-medium">{r.changedByName ?? "—"}</td>
                <td className="px-3 py-2 uppercase text-neutral-400">{r.ledgerType}</td>
                <td className={`px-3 py-2 font-medium ${r.action === "delete" ? "text-red-400" : "text-amber-400"}`}>{r.action}</td>
                <td className="px-3 py-2">{characterName}</td>
                <td className="px-3 py-2 text-neutral-400">{summarize(r.before, r.ledgerType)}</td>
                <td className="px-3 py-2 text-neutral-400">{r.after ? summarize(r.after, r.ledgerType) : "(deleted)"}</td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-6 text-center text-neutral-500">
                No edits or deletes recorded yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
