import { redirect } from "next/navigation";

import { BankBrowseTable } from "@/components/bank/BankBrowseTable";
import { PageHeader } from "@/components/shell/PageHeader";
import { listBankHoldings } from "@/lib/bank/holdings";
import { BANK_UNDER_CONSTRUCTION } from "@/lib/bank/constants";
import { loadBankConfig } from "@/lib/bank/sync";
import { getDb } from "@/lib/db";
import { getPermissions } from "@/lib/permissions";
import { getSession } from "@/lib/session";

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
export default async function BankPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const perms = await getPermissions(session.user.id);
  const db = await getDb();
  const [holdings, bankConfig] = await Promise.all([listBankHoldings(db), loadBankConfig(db)]);
  const lastImports = [...bankConfig.lastImports.values()].map((info) => ({
    ...info,
    createdAt: info.createdAt.toISOString(),
  }));

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
      <BankBrowseTable holdings={holdings} canManage={perms.can("epgp.bank.manage")} lastImports={lastImports} />
    </div>
  );
}
