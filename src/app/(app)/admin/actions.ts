"use server";

import { eq, inArray } from "drizzle-orm";
import { redirect } from "next/navigation";

import { characters, players, users } from "@/db";
import { canManageRoles, getUserRole, LEADERSHIP_ROLES, type Role } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { commitDepartureWipe, reverseDecayEvent } from "@/lib/epgp/decay";
import { swapMainCharacter, type SwapMainResult } from "@/lib/players";
import { getSession } from "@/lib/session";

export type SetRoleResult = { error?: string };

export type MemberGuildStatusResult = { error?: string };

export type { SwapMainResult };

// Hard character deletion was removed 2026-09-04 — the leader's call: there
// should always be a record and an audit trail. Removing a person now goes
// through removeMemberFromGuild (player-level, reversible); a genuinely
// bogus character row is a SQL-sandbox cleanup, not a routine admin button.

const ROLES: Role[] = ["member", "officer", "leader", "admin"];

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

  // Guard against locking the guild out of the admin panel: stepping down
  // out of leadership tier (self or otherwise) must leave at least one
  // leader/admin behind. admin outranks leader (2026-09-05) and is an
  // equally valid successor — LEADERSHIP_ROLES is the shared definition,
  // so promoting the sole leader to admin is a lateral move within
  // leadership tier and never trips this, only a drop to member/officer
  // does. This used to check `role !== "leader"` literally, which wrongly
  // treated leader->admin as the demotion it's actually guarding against.
  if (!canManageRoles(role as Role)) {
    const [target] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
    if (target && LEADERSHIP_ROLES.includes(target.role as Role)) {
      const leaders = await db.select({ id: users.id }).from(users).where(inArray(users.role, LEADERSHIP_ROLES));
      if (leaders.length <= 1) {
        return { error: "Can't demote the only leader/admin — promote someone else first." };
      }
    }
  }

  await db
    .update(users)
    .set({ role: role as Role, updatedAt: new Date() })
    .where(eq(users.id, userId));

  return {};
}

// PLAN.md §11 Phase 10 task 10.3 — "leader-approved main swap." Leader/admin
// only (canManageRoles — same bar as role promotion/demotion, §4c/§10's
// "leader-approved"), unlike claim approval (canManageAnyCharacter, includes
// officers) — a main swap changes who a player's roster/priority identity
// is, a bigger call than approving an ownership claim.
export async function setPlayerMainCharacter(playerId: number, characterId: number): Promise<SwapMainResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);
  if (!canManageRoles(role)) {
    return { error: "Only leaders can change a player's main character." };
  }

  const db = await getDb();
  return swapMainCharacter(db, playerId, characterId, session.user.id);
}

// Leader/admin action (canManageRoles). "Removed from the guild" is a
// player-level state, deliberately distinct from a character's own
// `removed` status (in-game/roster housekeeping, never affects access on
// its own — confirmed with the leader 2026-08-29). It does three things,
// all reversible by reinstateMember:
//   1. drops the person's site role to `member`
//   2. flips players.status to `departed` — (app)/layout.tsx's gate treats
//      that like a failed Discord check: no page access, bounced to
//      /access-denied
//   3. zeroes the player's EP across all their characters (a `departure`
//      decay_events batch — §1e: GP is never touched). The event id is
//      stashed on players.removalDecayEventId so reinstate can reverse it.
// Character records and GP history stay as-is. The role is NOT auto-restored
// on reinstate — a leader re-grants it deliberately.
export async function removeMemberFromGuild(userId: string): Promise<MemberGuildStatusResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const actingRole = await getUserRole(session.user.id);
  if (!canManageRoles(actingRole)) {
    return { error: "Only leaders can remove a member from the guild." };
  }
  if (userId === session.user.id) {
    return { error: "You can't remove yourself — sign out instead." };
  }

  const db = await getDb();
  const [target] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  if (!target) return { error: "Member not found." };

  // Same last-leader guard as setUserRole: removing a leader strips their
  // role, so the guild must not be left with zero leaders.
  if (target.role === "leader") {
    const leaders = await db.select({ id: users.id }).from(users).where(eq(users.role, "leader"));
    if (leaders.length <= 1) {
      return { error: "Can't remove the only leader — promote someone else first." };
    }
  }

  const now = new Date();
  await db.update(users).set({ role: "member", updatedAt: now }).where(eq(users.id, userId));

  // Zero their EP. `commitDepartureWipe` skips characters already at 0 EP
  // and returns an error only when nothing matched — that's not a failure
  // here, just "no EP to wipe", so removalDecayEventId stays null.
  const [player] = await db.select({ id: players.id }).from(players).where(eq(players.userId, userId));
  let removalDecayEventId: number | null = null;
  if (player) {
    const chars = await db.select({ id: characters.id }).from(characters).where(eq(characters.playerId, player.id));
    if (chars.length > 0) {
      const outcome = await commitDepartureWipe(db, {
        characterIds: chars.map((c) => c.id),
        label: "Removed from guild",
        appliedBy: session.user.id,
      });
      if (!("error" in outcome)) removalDecayEventId = outcome.decayEventId;
    }
  }

  // A user who has never logged in since Phase 10 may have no players row
  // yet; this updates 0 rows in that case and their next login creates the
  // row as `active`. Acceptable — every active member has logged in since
  // Phase 10 shipped (2026-08-24).
  await db
    .update(players)
    .set({ status: "departed", departedAt: now, removalDecayEventId, statusChangedBy: session.user.id, statusChangedAt: now, updatedAt: now })
    .where(eq(players.userId, userId));

  return {};
}

// Full reverse of removeMemberFromGuild's EP wipe + status, but NOT the
// role (a leader re-grants that). Safe if the departure event was already
// reversed by hand on /epgp/decay — that just clears the pointer.
export async function reinstateMember(userId: string): Promise<MemberGuildStatusResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const actingRole = await getUserRole(session.user.id);
  if (!canManageRoles(actingRole)) {
    return { error: "Only leaders can reinstate a member." };
  }

  const db = await getDb();
  const now = new Date();

  const [player] = await db
    .select({ id: players.id, removalDecayEventId: players.removalDecayEventId })
    .from(players)
    .where(eq(players.userId, userId));

  if (player?.removalDecayEventId != null) {
    const outcome = await reverseDecayEvent(db, player.removalDecayEventId, session.user.id);
    if ("error" in outcome && !/already reversed|not found/i.test(outcome.error)) {
      return { error: `Couldn't restore EP: ${outcome.error}` };
    }
  }

  await db
    .update(players)
    .set({ status: "active", departedAt: null, removalDecayEventId: null, statusChangedBy: session.user.id, statusChangedAt: now, updatedAt: now })
    .where(eq(players.userId, userId));

  return {};
}
