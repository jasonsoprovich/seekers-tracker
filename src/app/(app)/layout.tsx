import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppShell } from "@/components/shell/AppShell";
import { ViewAsBanner } from "@/components/shell/ViewAsBanner";
import { players, users } from "@/db";
import { getViewAsRole } from "@/lib/authz";
import { isMemberAllowed } from "@/lib/discord-verify";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const [me] = await db
    .select({
      username: users.username,
      avatarUrl: users.avatarUrl,
      role: users.role,
      discordVerified: users.discordVerified,
      discordRoleIds: users.discordRoleIds,
      // Joined so isMemberAllowed can also reject a leader-initiated guild
      // removal (players.status 'departed') in the same query — see
      // src/app/(app)/admin/actions.ts removeMemberFromGuild.
      playerStatus: players.status,
    })
    .from(users)
    .leftJoin(players, eq(players.userId, users.id))
    .where(eq(users.id, session.user.id));

  // PLAN.md §4b / Phase 6 task 6.2: deny-list gate, cached on the user row
  // by the session.create.after hook (src/auth/index.ts) and re-verified
  // each login rather than on every request (task 6.3). Applies ahead of
  // everything under (app) — every page here, including bootstrap-leader —
  // regardless of site `role`, which stays a separate admin-panel-driven
  // axis (task 6.4).
  if (!isMemberAllowed(me)) {
    redirect("/access-denied");
  }

  // Admin "view as" preview (admin/view-as-actions.ts): only ever set when
  // the real DB role is admin (getUserRole() enforces the same gate for
  // every canManage*() check), so effectiveRole only ever narrows, never
  // widens, what this session can do.
  const realRole = me?.role ?? null;
  const viewAsRole = realRole === "admin" ? await getViewAsRole() : null;
  const effectiveRole = viewAsRole ?? realRole;

  return (
    <>
      {viewAsRole && <ViewAsBanner role={viewAsRole} />}
      <AppShell username={me?.username ?? "Member"} avatarUrl={me?.avatarUrl ?? null} role={effectiveRole}>
        {children}
      </AppShell>
    </>
  );
}
