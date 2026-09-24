import { redirect } from "next/navigation";

import { BankTabs } from "@/components/bank/BankTabs";
import { PageHeader } from "@/components/shell/PageHeader";
import { listBankHoldings } from "@/lib/bank/holdings";
import { loadBankConfig } from "@/lib/bank/sync";
import { getDb } from "@/lib/db";
import { getPermissions } from "@/lib/permissions";
import { listSkyBankRewards, listSkyBankStock } from "@/lib/quest-flags/list";
import { getSession } from "@/lib/session";

// Visible to every role (member/officer/leader) — same read-only-by-
// default pattern as /roster. Only add/edit/delete (task 8.6) are
// officer-gated, via BankBrowseTable's canManage prop and actions.ts's own
// server-side check (never trust the client-side gate alone).
//
// Gained a Sky Bank tab 2026-08-25 (PLAN.md-adjacent nav/security
// restructure) — listSkyBankRewards/listSkyBankStock are the same query
// functions /keys already uses; kept there too rather than moved, since
// character_key_flags (the other half of /keys) has no home here.
export default async function BankPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const perms = await getPermissions(session.user.id);
  const db = await getDb();
  const [holdings, skyRewards, skyStock, bankConfig] = await Promise.all([
    listBankHoldings(db),
    listSkyBankRewards(db),
    listSkyBankStock(db),
    loadBankConfig(db),
  ]);
  const lastImports = [...bankConfig.lastImports.values()].map((info) => ({
    ...info,
    createdAt: info.createdAt.toISOString(),
  }));

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Guild Bank"
        subtitle="Items, spells, and currency held across the guild's mules, plus the Sky Bank quest-reward catalog. Synced from in-game inventory exports via the officer app's Guild Bank tab, plus anything an officer's added by hand."
      />
      <BankTabs holdings={holdings} canManage={perms.can("epgp.bank.manage")} skyRewards={skyRewards} skyStock={skyStock} lastImports={lastImports} />
    </div>
  );
}
