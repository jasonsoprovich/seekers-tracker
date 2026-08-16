import { eq } from "drizzle-orm";

import { users } from "@/db";

import { getDb } from "./db";

export type Role = "member" | "officer" | "leader";

// Always re-read from D1 rather than trusting session.user.role — a role
// change (Task 11's own admin panel) must take effect on the next request,
// not the next re-login.
export async function getUserRole(userId: string): Promise<Role | null> {
  const db = await getDb();
  const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  return row?.role ?? null;
}

// officer/leader: "+ edit/view any member's characters" (docs/guild-website-
// feasibility.md §3 role table).
export function canManageAnyCharacter(role: Role | null): boolean {
  return role === "officer" || role === "leader";
}

// leader only: "+ promote/demote roles, remove members/characters, site
// settings".
export function canManageRoles(role: Role | null): boolean {
  return role === "leader";
}

// Whether the guild has anyone to promote/demote with yet — false only in
// the window between the first Discord sign-in and Task 13's bootstrap
// claim, when /admin's role management is otherwise unreachable.
export async function hasAnyLeader(): Promise<boolean> {
  const db = await getDb();
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.role, "leader"));
  return row !== undefined;
}
