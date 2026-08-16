"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { users } from "@/db";
import { canManageRoles, getUserRole, type Role } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";

export type SetRoleResult = { error?: string };

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
