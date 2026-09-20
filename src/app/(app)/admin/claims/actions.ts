"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { characterClaims, characters } from "@/db";
import { resolveOtherPendingClaimsForGroup } from "@/lib/claims";
import { getDb } from "@/lib/db";
import { settleStandings } from "@/lib/epgp/standings";
import { assignCharacterToUser } from "@/lib/players";
import { getPermissions } from "@/lib/permissions";
import { getSession } from "@/lib/session";
import { recordSystemEvent, webActor } from "@/lib/system-log";

export type ClaimReviewResult = { error?: string };

export async function approveClaim(claimId: number): Promise<ClaimReviewResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const perms = await getPermissions(session.user.id);
  if (!perms.can("claims.review")) {
    return { error: "Only officers and leaders can review claims." };
  }

  const db = await getDb();
  const [claim] = await db.select().from(characterClaims).where(eq(characterClaims.id, claimId));
  if (!claim) return { error: "Claim not found." };
  if (claim.status !== "pending") return { error: "That claim has already been reviewed." };

  const now = new Date();

  // Feedback-loop fix (post-live-test-1 LT-14): an admin can assign a
  // character to a member directly (admin/actions.ts) without noticing a
  // pending claim for it. That left the claim un-approvable — assignment
  // below would fail "already claimed" — and un-deniable in spirit (the
  // request was legitimate, it's just already fulfilled). Resolve it by
  // outcome instead of hard-blocking:
  //   - already owned by THIS requester  -> mark approved, nothing to assign
  //   - owned by a DIFFERENT account     -> actionable error; Deny still works
  //   - unowned                          -> normal assignment path
  const [character] = await db
    .select({ name: characters.name, ownerId: characters.ownerId, playerId: characters.playerId })
    .from(characters)
    .where(eq(characters.id, claim.characterId));
  if (!character) return { error: "That character no longer exists." };

  const actor = await webActor(db, session.user.id);

  if (character.ownerId === claim.requesterId) {
    await db
      .update(characterClaims)
      .set({
        status: "approved",
        decisionNote: "Character was already assigned to this member.",
        reviewedBy: session.user.id,
        reviewedAt: now,
      })
      .where(eq(characterClaims.id, claimId));
    await recordSystemEvent(db, actor, {
      action: "claims.approve",
      targetType: "character",
      targetId: claim.characterId,
      targetLabel: character.name,
      summary: `Claim on ${character.name} approved (already assigned to requester)`,
      after: { claimId, requesterId: claim.requesterId },
    });
    // Remediation plan Phase 5 task 5.5 — resolve against the character's
    // whole main/alt/mule group, not just the claimed character, since any
    // sibling's own pending claim is moot the same way this one is.
    await resolveOtherPendingClaimsForGroup(db, character.playerId, claim.characterId, claim.requesterId, claimId, session.user.id, now);
    return {};
  }

  if (character.ownerId !== null) {
    return {
      error:
        "That character is already owned by another account. Reassign it in Admin → Characters first, or deny this request.",
    };
  }

  // Resolves the requester's player and attaches the character to it —
  // which pulls in the character's complete main/alt/mule group and syncs
  // owner_id across all of it (task 5.4), or refuses outright if that group
  // belongs to a different real identity (task 5.6). Shared with the
  // "assign a character to a member" admin action so the two can't drift.
  const assigned = await assignCharacterToUser(db, claim.characterId, claim.requesterId, actor);
  if (!assigned.ok) return { error: assigned.error };

  await db
    .update(characterClaims)
    .set({ status: "approved", reviewedBy: session.user.id, reviewedAt: now })
    .where(eq(characterClaims.id, claimId));
  await recordSystemEvent(db, actor, {
    action: "claims.approve",
    targetType: "character",
    targetId: claim.characterId,
    targetLabel: character.name,
    summary: `Claim on ${character.name} approved`,
    after: { claimId, requesterId: claim.requesterId, playerId: assigned.playerId },
  });

  // assignCharacterToUser may have absorbed a defunct standalone player
  // (its ledger history moved onto this player), so recompute standings.
  if (assigned.playerId != null) await settleStandings(db, { playerIds: [assigned.playerId] });

  // Task 5.5/5.7 — resolve against the RESULTING group (assigned.playerId),
  // since absorption may have just pulled in siblings the claimed character
  // didn't originally share a player row with.
  await resolveOtherPendingClaimsForGroup(db, assigned.playerId, claim.characterId, claim.requesterId, claimId, session.user.id, now);

  return {};
}

export async function denyClaim(claimId: number, decisionNote: string): Promise<ClaimReviewResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const perms = await getPermissions(session.user.id);
  if (!perms.can("claims.review")) {
    return { error: "Only officers and leaders can review claims." };
  }

  const db = await getDb();
  const [claim] = await db
    .select({ status: characterClaims.status, characterId: characterClaims.characterId, requesterId: characterClaims.requesterId })
    .from(characterClaims)
    .where(eq(characterClaims.id, claimId));
  if (!claim) return { error: "Claim not found." };
  if (claim.status !== "pending") return { error: "That claim has already been reviewed." };

  await db
    .update(characterClaims)
    .set({
      status: "denied",
      decisionNote: decisionNote.trim().slice(0, 500) || null,
      reviewedBy: session.user.id,
      reviewedAt: new Date(),
    })
    .where(eq(characterClaims.id, claimId));

  const [character] = await db.select({ name: characters.name }).from(characters).where(eq(characters.id, claim.characterId));
  const actor = await webActor(db, session.user.id);
  await recordSystemEvent(db, actor, {
    action: "claims.deny",
    targetType: "character",
    targetId: claim.characterId,
    targetLabel: character?.name ?? null,
    summary: `Claim on ${character?.name ?? `character #${claim.characterId}`} denied`,
    after: { claimId, requesterId: claim.requesterId, decisionNote },
  });

  return {};
}
