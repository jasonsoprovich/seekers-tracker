import { redirect } from "next/navigation";

import { SqlSandboxForm } from "@/components/epgp/SqlSandboxForm";
import { PageHeader } from "@/components/shell/PageHeader";
import { canManageEpgp, getUserRole } from "@/lib/authz";
import { getSession } from "@/lib/session";

// Officer/leader/admin only — gated here (not just in the server action) so
// members never see the sandbox exists. See src/app/(app)/epgp/sql/actions.ts
// for the actual read-only enforcement.
export default async function EpgpSqlPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);
  if (!canManageEpgp(role)) redirect("/roster");

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="EPGP SQL Sandbox"
        subtitle="Read-only SELECT queries against the live database, for testing and debugging. Writes are rejected."
      />
      <SqlSandboxForm />
    </div>
  );
}
