import { eq, inArray } from "drizzle-orm";
import { cookies } from "next/headers";
import { cache } from "react";

import { users } from "@/db";

import { getDb } from "./db";

export type Role = "member" | "officer" | "leader" | "admin";

// Admin "view as" preview (see admin/view-as-actions.ts). An admin can
// preview the site as a lower role to verify nav/UI/permissions without a
// second test account. Deliberately excludes "admin" — nothing to preview.
export const VIEW_AS_COOKIE = "seekers_view_as_role";
export const VIEW_AS_ROLES: readonly Role[] = ["member", "officer", "leader"];

// The literal DB value, never overridden by a view-as preview. Used to gate
// who may enter/inspect preview mode (admin/view-as-actions.ts,
// (app)/layout.tsx's banner, admin/page.tsx's controls) — must not itself
// be preview-aware, or an admin previewing "member" could never get back.
export const getRealUserRole = cache(async function getRealUserRole(userId: string): Promise<Role | null> {
  const db = await getDb();
  const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  return row?.role ?? null;
});

// The active view-as cookie, if any, validated against VIEW_AS_ROLES.
// Reading this alone (without checking the real role is admin) is never
// sufficient to authorize anything — see getUserRole below.
export async function getViewAsRole(): Promise<Role | null> {
  const store = await cookies();
  const value = store.get(VIEW_AS_COOKIE)?.value;
  return value && (VIEW_AS_ROLES as readonly string[]).includes(value) ? (value as Role) : null;
}

// Always re-read from D1 rather than trusting session.user.role — a role
// change (Task 11's own admin panel) must take effect on the next request,
// not the next re-login. cache()'d for the same reason as getSession() —
// canManageCharacter() below and several pages each call this per request.
//
// Preview-aware: every canManage*() gate and every one of the ~30 call
// sites below run through this function, always with the *acting* user's
// own id (never a target user's), so layering the view-as override here —
// rather than touching each call site — is sufficient to make a preview
// airtight: an admin viewing as "member" really can't reach admin actions,
// not just the admin nav link. Only ever narrows a real admin's own
// effective role for the current request; can never widen anyone else's,
// since it only applies when the freshly-read DB role is "admin".
export const getUserRole = cache(async function getUserRole(userId: string): Promise<Role | null> {
  const realRole = await getRealUserRole(userId);
  if (realRole === "admin") {
    const viewAs = await getViewAsRole();
    if (viewAs) return viewAs;
  }
  return realRole;
});

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

// admin outranks leader (2026-09-05 leader request: "able to do everything
// the guild leader can do plus view the site as other users") — every
// leader-tier gate in this file already treats them as equivalent
// (canManageRoles, canManageEpgpConfig). "Does the guild have leadership
// yet" checks need the same equivalence: three call sites used to query
// role='leader' alone, so a guild whose only privileged account was
// promoted to admin would wrongly look leaderless — reopening the
// self-claim bootstrap flow below to anyone. LEADERSHIP_ROLES is the
// shared source of truth for all of them.
export const LEADERSHIP_ROLES: readonly Role[] = ["leader", "admin"];

// Whether the guild has anyone to promote/demote with yet — false only in
// the window between the first Discord sign-in and Task 13's bootstrap
// claim, when /admin's role management is otherwise unreachable.
export async function hasAnyLeader(): Promise<boolean> {
  const db = await getDb();
  const [row] = await db.select({ id: users.id }).from(users).where(inArray(users.role, LEADERSHIP_ROLES));
  return row !== undefined;
}
