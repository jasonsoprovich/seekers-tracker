import { desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/shell/PageHeader";
import { characters, ledgerAuditLog, users } from "@/db";
import { canManageEpgp, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";

const PAGE_SIZE = 50;

// Read view for ledger_audit_log — every edit/delete against ep_ledger/
// gp_ledger, who made it, and the whole-row before/after snapshot. New
// entries (source: manual/parse/import) aren't audited here — they're
// fully explained by the row's own entered_by/source columns already
// shown on /epgp/ledger; this page only covers changes to rows that
// already existed.
export default async function LedgerAuditPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);
  if (!canManageEpgp(role)) redirect("/epgp/ledger");

  const { page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const db = await getDb();
  const rows = await db
    .select({
      id: ledgerAuditLog.id,
      ledgerType: ledgerAuditLog.ledgerType,
      ledgerId: ledgerAuditLog.ledgerId,
      action: ledgerAuditLog.action,
      changedAt: ledgerAuditLog.changedAt,
      changedByName: users.username,
      before: ledgerAuditLog.before,
      after: ledgerAuditLog.after,
    })
    .from(ledgerAuditLog)
    .leftJoin(users, eq(ledgerAuditLog.changedBy, users.id))
    .orderBy(desc(ledgerAuditLog.changedAt))
    .limit(PAGE_SIZE + 1)
    .offset(offset);

  const hasNext = rows.length > PAGE_SIZE;
  const pageRows = rows.slice(0, PAGE_SIZE);

  const characterIds = new Set<number>();
  for (const r of pageRows) {
    const snapshot = (r.before ?? r.after) as Record<string, unknown> | null;
    const id = snapshot?.characterId;
    if (typeof id === "number") characterIds.add(id);
  }
  const characterRows = characterIds.size
    ? await db.select({ id: characters.id, name: characters.name }).from(characters).where(inArray(characters.id, [...characterIds]))
    : [];
  const characterNames = new Map(characterRows.map((c) => [c.id, c.name]));

  function summarize(snapshot: unknown, ledgerType: "ep" | "gp"): string {
    if (!snapshot || typeof snapshot !== "object") return "—";
    const s = snapshot as Record<string, unknown>;
    return ledgerType === "ep" ? `${s.activity} · ${s.points} pts` : `${s.itemName ?? "(no item)"} · ${s.tier} · ${s.points} pts`;
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Ledger Audit Trail" subtitle="Every edit and delete made to an existing EP/GP ledger row, who made it, and what changed." />

      <div className="mb-4">
        <Link href="/epgp/ledger" className="text-sm text-emerald-400 hover:text-emerald-300">
          ← Back to Ledger
        </Link>
      </div>

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
            {pageRows.map((r) => {
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
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-neutral-500">
                  No edits or deletes recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center justify-between text-sm">
        <span className="text-neutral-500">Page {page}</span>
        <div className="flex gap-2">
          {page > 1 && (
            <Link href={`/epgp/ledger/audit?page=${page - 1}`} className="rounded-md border border-field px-3 py-1.5 font-medium text-neutral-300 hover:bg-neutral-900/60">
              ← Prev
            </Link>
          )}
          {hasNext && (
            <Link href={`/epgp/ledger/audit?page=${page + 1}`} className="rounded-md border border-field px-3 py-1.5 font-medium text-neutral-300 hover:bg-neutral-900/60">
              Next →
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
