import Link from "next/link";
import { redirect } from "next/navigation";

import { BankAuditLogTable } from "@/components/bank/BankAuditLogTable";
import { BankBrowseTable } from "@/components/bank/BankBrowseTable";
import { PageHeader } from "@/components/shell/PageHeader";
import { fieldClasses } from "@/components/ui/Field";
import { listBankAuditLog } from "@/lib/bank/audit";
import { BANK_UNDER_CONSTRUCTION } from "@/lib/bank/constants";
import { listBankHoldings } from "@/lib/bank/holdings";
import { loadBankConfig } from "@/lib/bank/sync";
import { getDb } from "@/lib/db";
import { getPermissions } from "@/lib/permissions";
import { getSession } from "@/lib/session";

const PAGE_SIZE = 50;

type TabType = "browse" | "audit";
type SearchParams = { tab?: string; q?: string; page?: string };

// Visible to every role (member/officer/leader) — same read-only-by-
// default pattern as /roster. Only add/edit/delete/retire (task 8.6, plus
// the 2026-09-25 sheet-retirement addition) are officer-gated, via
// BankBrowseTable's canManage prop and actions.ts's own server-side check
// (never trust the client-side gate alone).
//
// Sky Bank was a second tab here 2026-08-25 through 2026-09-24; folded
// back out 2026-09-25 per officer feedback — the guild has no reliable way
// to tell which items are actually for Plane of Sky quests vs. which
// class, so those items are now just ordinary bank_holdings rows like
// everything else. sky_bank_rewards/sky_bank_stock (the quest-reward
// catalog, a genuinely different kind of data with no holder/slot) still
// live on /keys, untouched.
//
// "Audit" (2026-09-26) is the item-level history behind these numbers —
// every add/remove/change a real sync or a manual edit has made
// (bank_audit_log, src/lib/bank/audit.ts). Member-visible like the tab
// next to it, and deliberately its OWN table/query — see that schema
// comment for why this isn't the EPGP ledger's Audit Trail or the
// admin-only System Log.
export default async function BankPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const perms = await getPermissions(session.user.id);
  const db = await getDb();

  const { tab: tabParam, q = "", page: pageParam } = await searchParams;
  const tab: TabType = tabParam === "audit" ? "audit" : "browse";
  const page = Math.max(1, Number(pageParam) || 1);
  const term = q.trim();

  function pageHref(overrides: { tab?: TabType; page?: number; q?: string }) {
    const params = new URLSearchParams();
    params.set("tab", overrides.tab ?? tab);
    const nextQ = overrides.q ?? term;
    if (nextQ) params.set("q", nextQ);
    params.set("page", String(overrides.page ?? page));
    return `/bank?${params.toString()}`;
  }

  let holdings: Awaited<ReturnType<typeof listBankHoldings>> = [];
  let lastImports: { characterId: number; sourceFile: string | null; rowCount: number; reportsSharedBank: boolean; uploadedByName: string | null; createdAt: string }[] = [];
  let auditRows: Awaited<ReturnType<typeof listBankAuditLog>>["rows"] = [];
  let hasNext = false;

  if (tab === "browse") {
    const [holdingRows, bankConfig] = await Promise.all([listBankHoldings(db), loadBankConfig(db)]);
    holdings = holdingRows;
    lastImports = [...bankConfig.lastImports.values()].map((info) => ({ ...info, createdAt: info.createdAt.toISOString() }));
  } else {
    const result = await listBankAuditLog(db, { q: term, page, pageSize: PAGE_SIZE });
    auditRows = result.rows;
    hasNext = result.hasNext;
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Guild Bank"
        subtitle="Items and spells held across the guild's mules. Synced from in-game inventory exports via the officer app's Guild Bank tab, plus anything an officer's added by hand."
      />
      {BANK_UNDER_CONSTRUCTION && (
        <div className="mb-4 rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          <span className="font-semibold">Guild bank under construction</span> — items may not be fully in sync while the
          transition from the old spreadsheet to live officer syncs is in progress.
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {(["browse", "audit"] as const).map((t) => (
            <Link
              key={t}
              href={pageHref({ tab: t, page: 1, q: "" })}
              prefetch={false}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${tab === t ? "bg-accent text-black" : "border border-field text-neutral-300 hover:bg-neutral-900/60"}`}
            >
              {t === "browse" ? "Browse" : "Audit"}
            </Link>
          ))}
        </div>

        {tab === "audit" && (
          // A plain GET form, not the debounced LedgerSearchBox client
          // component /epgp/ledger uses — this is a low-traffic officer
          // debugging tool (same audience/cadence as /admin/logs, which
          // already uses this exact pattern), not a page worth a client
          // component + a function-prop boundary for.
          <form method="get" className="flex items-end gap-2">
            <input type="hidden" name="tab" value="audit" />
            <input type="text" name="q" defaultValue={term} placeholder="Holder, item, officer…" className={`${fieldClasses({ size: "sm" })} w-56`} />
            <button type="submit" className="rounded-md border border-field px-3 py-1.5 text-sm font-medium text-neutral-300 hover:bg-neutral-900/60">
              Search
            </button>
          </form>
        )}
      </div>

      <div className="mt-4">
        {tab === "browse" && <BankBrowseTable holdings={holdings} canManage={perms.can("epgp.bank.manage")} lastImports={lastImports} />}
        {tab === "audit" && <BankAuditLogTable rows={auditRows} />}
      </div>

      {tab === "audit" && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <span className="text-neutral-500">Page {page}</span>
          <div className="flex gap-2">
            {page > 1 && (
              <Link href={pageHref({ page: page - 1 })} className="rounded-md border border-field px-3 py-1.5 font-medium text-neutral-300 hover:bg-neutral-900/60">
                ← Prev
              </Link>
            )}
            {hasNext && (
              <Link href={pageHref({ page: page + 1 })} className="rounded-md border border-field px-3 py-1.5 font-medium text-neutral-300 hover:bg-neutral-900/60">
                Next →
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
