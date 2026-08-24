import { redirect } from "next/navigation";

import { QuestFlagsView } from "@/components/quest-flags/QuestFlagsView";
import { PageHeader } from "@/components/shell/PageHeader";
import { getDb } from "@/lib/db";
import { listCharacterKeyFlags, listSkyBankRewards, listSkyBankStock } from "@/lib/quest-flags/list";
import { getSession } from "@/lib/session";

// Visible to every role, read-only — same guild-wide-transparency call as
// /roster, /bank, /progression (PLAN.md §11 Phase 11 task 11.3). Editing
// (mirroring bank's 8.6 manual add/edit) wasn't part of this phase's task
// list and is left for a follow-up.
export default async function KeysPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const [keyFlags, rewards, stock] = await Promise.all([
    listCharacterKeyFlags(db),
    listSkyBankRewards(db),
    listSkyBankStock(db),
  ]);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Keys & Sky Bank"
        subtitle="EmpVT/ST attunement per character, plus the Sky Bank's No-Drop reward catalog and hand-counted stock. Imported from the guild's EPGP sheet (PLAN.md §11 Phase 11)."
      />
      <QuestFlagsView keyFlags={keyFlags} rewards={rewards} stock={stock} />
    </div>
  );
}
