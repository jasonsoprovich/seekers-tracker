import { eq } from "drizzle-orm";

import { users } from "@/db";

import { getDb } from "./db";

export type Role = "member" | "officer" | "leader" | "admin";

// Always re-read from D1 rather than trusting session.user.role — a role
// change (Task 11's own admin panel) must take effect on the next request,
// not the next re-login.
export async function getUserRole(userId: string): Promise<Role | null> {
  const db = await getDb();
  const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  return row?.role ?? null;
}

// officer/leader/admin: "+ edit/view any member's characters" (docs/guild-
// website-feasibility.md §3 role table). admin (site/dev administration) is
// a superset here even though it isn't a guild-loot role.
export function canManageAnyCharacter(role: Role | null): boolean {
  return role === "officer" || role === "leader" || role === "admin";
}

// leader/admin: "+ promote/demote roles, remove members/characters, site
// settings".
export function canManageRoles(role: Role | null): boolean {
  return role === "leader" || role === "admin";
}

// officer/leader/admin: run read-only SQL against the EPGP tables (query/
// display page) and enter/edit EP/GP ledger rows and bids.
export function canManageEpgp(role: Role | null): boolean {
  return role === "officer" || role === "leader" || role === "admin";
}

// leader/admin: tune EPGP settings (base EP/GP, decay %, cycle cap, point
// values) — a guild-leadership call, not an every-officer one.
export function canManageEpgpConfig(role: Role | null): boolean {
  return role === "leader" || role === "admin";
}

// The ownership-or-officer check repeated across every character route
// (view, edit, gear, stats, import): the owner can always manage their own
// character; anyone else needs canManageAnyCharacter.
export async function canManageCharacter(
  character: { ownerId: string | null } | undefined,
  userId: string,
): Promise<boolean> {
  if (!character) return false;
  if (character.ownerId === userId) return true;
  return canManageAnyCharacter(await getUserRole(userId));
}

// Whether the guild has anyone to promote/demote with yet — false only in
// the window between the first Discord sign-in and Task 13's bootstrap
// claim, when /admin's role management is otherwise unreachable.
export async function hasAnyLeader(): Promise<boolean> {
  const db = await getDb();
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.role, "leader"));
  return row !== undefined;
}
