"use server";

import { eq, inArray } from "drizzle-orm";
import { redirect } from "next/navigation";

import { players, users } from "@/db";
import { revokeApiKeysForUser } from "@/lib/api-key-auth";
import { getRealUserRole, LEADERSHIP_ROLES, roleRank, type Role } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { settleStandings } from "@/lib/epgp/standings";
import {
  assignCharacterToUser,
  MAIN_SWAP_FEE_GP,
  reinstatePlayerFromGuildCore,
  removePlayerFromGuildCore,
  reverseMainSwap,
  swapMainCharacter,
  type GuildStatusResult,
  type SwapMainResult,
} from "@/lib/players";
import { getPermissionMatrix, getPermissions, roleCan } from "@/lib/permissions";
import { getSession } from "@/lib/session";

export type SetRoleResult = { error?: string };

export type MemberGuildStatusResult = GuildStatusResult;

// Hard character deletion was removed 2026-09-04 — the leader's call: there
// should always be a record and an audit trail. Removing a person now goes
// through removeMemberFromGuild (player-level, reversible); a genuinely
// bogus character row is a SQL-sandbox cleanup, not a routine admin button.

const ROLES: Role[] = ["member", "officer", "leader", "admin"];

export async function setUserRole(userId: string, role: string): Promise<SetRoleResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const [perms, actingReal, matrix] = await Promise.all([
    getPermissions(session.user.id),
    getRealUserRole(session.user.id),
    getPermissionMatrix(),
  ]);
  if (!perms.can("members.role.manage")) {
    return { error: "Only leaders can change roles." };
  }
  if (!ROLES.includes(role as Role)) {
    return { error: "Invalid role." };
  }

  // Rank ceiling: nobody may grant a role above their own — closes the
  // escalation hole where an officer granted "members.role.manage" (a
  // matrix-tunable capability, unlike the old hardcoded leader-only gate)
  // could otherwise mint themselves admin and rewrite the whole matrix.
  // Checked against the REAL role (not a view-as preview), so an admin
  // previewing "leader" is never the one this restricts.
  if (roleRank(role as Role) > roleRank(actingReal)) {
    return { error: "You can't grant a role above your own." };
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
  if (!LEADERSHIP_ROLES.includes(role as Role)) {
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
  // The account row carries the same role (players.role is what the roster
  // and dashboard display) — keep it in step with the login's.
  await db
    .update(players)
    .set({ role: role as Role, updatedAt: new Date() })
    .where(eq(players.userId, userId));

  // Losing officer-API access (dropping to a role that no longer carries
  // "epgp.officerApi") means any app key they hold should stop existing,
  // not just stop working on its next live check (leader, 2026-09-05: "if
  // an officer ever loses their officer status... their api keys need to
  // be revoked automatically"). A no-op if they never had a key.
  if (!roleCan(matrix, role, "epgp.officerApi")) {
    await revokeApiKeysForUser(db, userId);
  }

  return {};
}

// PLAN.md §11 Phase 10 task 10.3 — "leader-approved main swap." Leader/admin
// only ("members.main.swap" — same default tier as role promotion/demotion,
// §4c/§10's "leader-approved"), unlike claim approval ("claims.review",
// includes officers) — a main swap changes who a player's roster/priority
// identity is, a bigger call than approving an ownership claim.
// post-live-test-1 LT-30: officers are excluded by default, and every swap
// charges the new main MAIN_SWAP_FEE_GP unless `waiveFee` is set on the
// confirm dialog.
export async function setPlayerMainCharacter(
  playerId: number,
  characterId: number,
  waiveFee: boolean,
): Promise<SwapMainResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const perms = await getPermissions(session.user.id);
  if (!perms.can("members.main.swap")) {
    return { error: "Only leaders and admins can change a player's main character." };
  }

  const db = await getDb();
  return swapMainCharacter(db, playerId, characterId, session.user.id, waiveFee ? 0 : MAIN_SWAP_FEE_GP);
}

// post-live-test-1 LT-30 — reverse a recorded main swap (restore the
// char-type grouping + refund the exact GP fee). Same bar; no time limit.
export async function reverseMainSwapAction(eventId: number): Promise<SwapMainResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const perms = await getPermissions(session.user.id);
  if (!perms.can("members.main.swap")) {
    return { error: "Only leaders and admins can reverse a main swap." };
  }

  const db = await getDb();
  return reverseMainSwap(db, eventId, session.user.id);
}

export type AssignCharacterResult = { error?: string };

// Officer/leader/admin ("members.assignCharacter" — the same default tier
// as approving a claim) attaching an unclaimed roster character straight to
// a member's account, for when an officer knows whose character it is and
// the member hasn't filed a claim. Shares approveClaim's core
// (assignCharacterToUser: re-check unclaimed → set owner → resolve player →
// attach + carry ledger history), then recomputes that player's standings.
export async function assignCharacterToMember(userId: string, characterId: number): Promise<AssignCharacterResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const perms = await getPermissions(session.user.id);
  if (!perms.can("members.assignCharacter")) {
    return { error: "Only officers, leaders, and admins can assign characters." };
  }
  if (!Number.isInteger(characterId) || characterId <= 0) {
    return { error: "Invalid character." };
  }

  const db = await getDb();
  const assigned = await assignCharacterToUser(db, characterId, userId);
  if (!assigned.ok) return { error: assigned.error };
  if (assigned.playerId != null) await settleStandings(db, { playerIds: [assigned.playerId] });
  return {};
}

// Officer/leader/admin action ("members.remove" — opened to officers
// 2026-09-19 at the guild leader's request; previously leader/admin only).
// "Removed from the guild" is a player-level state, deliberately distinct
// from a character's own `removed` status (in-game/roster housekeeping,
// never affects access on its own — confirmed with the leader 2026-08-29).
// It does three things, all reversible by reinstateMember:
//   1. drops the person's role to `member` (both users.role and
//      players.role — see removePlayerFromGuildCore's own comment)
//   2. flips players.status to `departed` — (app)/layout.tsx's gate treats
//      that like a failed Discord check: no page access, bounced to
//      /access-denied, until an explicit reinstatement (no auto-unlock on
//      a later login — see isMemberAllowed)
//   3. zeroes the player's EP across all their characters (a `departure`
//      decay_events batch — §1e: GP is never touched). The event id is
//      stashed on players.removalDecayEventId so reinstate can reverse it.
// Character records and GP history stay as-is. The role is NOT auto-restored
// on reinstate — an officer/leader re-grants it deliberately. The actual
// mutation lives in src/lib/players.ts (removePlayerFromGuildCore) — this
// wrapper's only job is the session/permission gate, same division as
// setPlayerMainCharacter above.
export async function removeMemberFromGuild(userId: string): Promise<MemberGuildStatusResult> {
  const session = await getSession();
  if (!session) redirect("/login");
  const perms = await getPermissions(session.user.id);
  if (!perms.can("members.remove")) {
    return { error: "Only officers, leaders, and admins can remove a member from the guild." };
  }
  const db = await getDb();
  const [player] = await db.select({ id: players.id }).from(players).where(eq(players.userId, userId));
  // A user who has never logged in since Phase 10 may have no players row
  // yet — every active member has (Phase 10 shipped 2026-08-24), so treat
  // it as "nothing to remove" rather than inventing a row.
  if (!player) return { error: "This member has no player account yet — nothing to remove." };
  return removePlayerFromGuildCore(db, session.user.id, player.id);
}

// Same removal, keyed by players.id (2026-09-10) — so a player who exists
// only from the roster import and never claimed a site account can be
// removed from /characters/[id]/account too. The role drop + key
// revocation only apply when the player has a linked site user.
export async function removePlayerFromGuild(playerId: number): Promise<MemberGuildStatusResult> {
  const session = await getSession();
  if (!session) redirect("/login");
  const perms = await getPermissions(session.user.id);
  if (!perms.can("members.remove")) {
    return { error: "Only officers, leaders, and admins can remove a member from the guild." };
  }
  const db = await getDb();
  return removePlayerFromGuildCore(db, session.user.id, playerId);
}

// Full reverse of removeMemberFromGuild's EP wipe + status, but NOT the
// role (an officer/leader re-grants that). Safe if the departure event was
// already reversed by hand on /epgp/decay — that just clears the pointer.
// The mutation lives in src/lib/players.ts (reinstatePlayerFromGuildCore).
export async function reinstateMember(userId: string): Promise<MemberGuildStatusResult> {
  const session = await getSession();
  if (!session) redirect("/login");
  const perms = await getPermissions(session.user.id);
  if (!perms.can("members.remove")) {
    return { error: "Only officers, leaders, and admins can reinstate a member." };
  }
  const db = await getDb();
  const [player] = await db.select({ id: players.id }).from(players).where(eq(players.userId, userId));
  if (!player) return { error: "This member has no player account." };
  return reinstatePlayerFromGuildCore(db, session.user.id, player.id);
}

export async function reinstatePlayer(playerId: number): Promise<MemberGuildStatusResult> {
  const session = await getSession();
  if (!session) redirect("/login");
  const perms = await getPermissions(session.user.id);
  if (!perms.can("members.remove")) {
    return { error: "Only officers, leaders, and admins can reinstate a member." };
  }
  const db = await getDb();
  return reinstatePlayerFromGuildCore(db, session.user.id, playerId);
}
