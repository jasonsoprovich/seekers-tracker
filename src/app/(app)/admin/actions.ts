"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { characterEpgp, characterGear, characterPopFlags, characterStats, characters, importLog, users } from "@/db";
import { canManageAnyCharacter, canManageRoles, getUserRole, type Role } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { syncEpgpTotals, type EpgpSyncResult } from "@/lib/epgp/sync";
import { getSession } from "@/lib/session";

export type SetRoleResult = { error?: string };

export type SyncEpgpResult = { result?: EpgpSyncResult; error?: string };

export type DeleteCharacterResult = { error?: string };

// Officer/leader-only (§9 task 11's admin panel). D1 doesn't enforce FKs by
// default and these tables have no ON DELETE CASCADE, so clean up every
// dependent row by hand: the four character_* child tables, the import log,
// and any alt whose mainCharacterId points at the character being removed
// (nulled rather than cascading — deleting a main shouldn't delete its
// alts).
export async function deleteCharacter(characterId: number): Promise<DeleteCharacterResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);
  if (!canManageAnyCharacter(role)) {
    return { error: "Only officers and leaders can delete characters." };
  }

  const db = await getDb();
  const [existing] = await db.select({ id: characters.id }).from(characters).where(eq(characters.id, characterId));
  if (!existing) return { error: "Character not found." };

  await db.update(characters).set({ mainCharacterId: null }).where(eq(characters.mainCharacterId, characterId));
  await db.delete(characterPopFlags).where(eq(characterPopFlags.characterId, characterId));
  await db.delete(characterGear).where(eq(characterGear.characterId, characterId));
  await db.delete(characterStats).where(eq(characterStats.characterId, characterId));
  await db.delete(characterEpgp).where(eq(characterEpgp.characterId, characterId));
  await db.delete(importLog).where(eq(importLog.characterId, characterId));
  await db.delete(characters).where(eq(characters.id, characterId));

  return {};
}

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
