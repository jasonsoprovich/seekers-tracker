import { redirect } from "next/navigation";

import { BankBrowseTable } from "@/components/bank/BankBrowseTable";
import { PageHeader } from "@/components/shell/PageHeader";
import { canManageEpgp, getUserRole } from "@/lib/authz";
import { listBankHoldings } from "@/lib/bank/holdings";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";

// Visible to every role (member/officer/leader) — same read-only-by-
// default pattern as /roster. Only add/edit/delete (task 8.6) are
// officer-gated, via BankBrowseTable's canManage prop and actions.ts's own
// server-side check (never trust the client-side gate alone).
export default async function BankPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);
  const db = await getDb();
  const holdings = await listBankHoldings(db);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Guild Bank"
        subtitle="Items and currency held across the guild's mules. Imported from in-game inventory exports (PLAN.md §11 Phase 8) plus anything an officer's added by hand."
      />
      <BankBrowseTable holdings={holdings} canManage={canManageEpgp(role)} />
    </div>
  );
}
