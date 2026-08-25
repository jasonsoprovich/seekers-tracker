import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppShell } from "@/components/shell/AppShell";
import { users } from "@/db";
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
    })
    .from(users)
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

  return (
    <AppShell username={me?.username ?? "Member"} avatarUrl={me?.avatarUrl ?? null} role={me?.role ?? null}>
      {children}
    </AppShell>
  );
}
