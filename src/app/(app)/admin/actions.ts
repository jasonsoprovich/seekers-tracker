"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { users } from "@/db";
import { canManageAnyCharacter, canManageRoles, getUserRole, type Role } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { syncEpgpTotals, type EpgpSyncResult } from "@/lib/epgp/sync";
import { getSession } from "@/lib/session";

export type SetRoleResult = { error?: string };

export type SyncEpgpResult = { result?: EpgpSyncResult; error?: string };

// officer/leader-triggered pull of the guild's EPGP sheet (§9 task 20). No
// Cloudflare Cron Trigger yet — a manual button is the safer first cut since
// the sheet's shape has already drifted once (§10); an officer watching the
// result each time surfaces that faster than a silent scheduled failure
// would, until the admin sync-health view (§9 task 21) exists.
export async function syncEpgp(): Promise<SyncEpgpResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);
  if (!canManageAnyCharacter(role)) {
    return { error: "Only officers and leaders can sync EPGP." };
  }

  const db = await getDb();
  try {
    const result = await syncEpgpTotals(db);
    return { result };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "EPGP sync failed." };
  }
}

const ROLES: Role[] = ["member", "officer", "leader"];

export async function setUserRole(userId: string, role: string): Promise<SetRoleResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const actingRole = await getUserRole(session.user.id);
  if (!canManageRoles(actingRole)) {
    return { error: "Only leaders can change roles." };
  }
  if (!ROLES.includes(role as Role)) {
    return { error: "Invalid role." };
  }

  const db = await getDb();

  // Guard against locking the guild out of the admin panel: a leader
  // stepping down (self or otherwise) must leave at least one leader.
  if (role !== "leader") {
    const [target] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
    if (target?.role === "leader") {
      const leaders = await db.select({ id: users.id }).from(users).where(eq(users.role, "leader"));
      if (leaders.length <= 1) {
        return { error: "Can't demote the only leader — promote someone else first." };
      }
    }
  }

  await db
    .update(users)
    .set({ role: role as Role, updatedAt: new Date() })
    .where(eq(users.id, userId));

  return {};
}
