import { redirect } from "next/navigation";

import { LiveBidsView } from "@/components/live-bids/LiveBidsView";
import { PageHeader } from "@/components/shell/PageHeader";
import { getSession } from "@/lib/session";

// Visible to every role, read-only — same guild-wide-transparency call as
// /roster, /bank, /keys, /progression (PLAN.md §15 / Phase 12 task 12.4).
export default async function LiveBidsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Live Bids"
        subtitle="Every officer's round at once, filling in as tells arrive. Finalized rounds stay up with their winner for a while so you can see who bid what."
      />
      <LiveBidsView />
    </div>
  );
}
