"use server";

import { and, eq, ne } from "drizzle-orm";
import { redirect } from "next/navigation";

import { characterClaims, characters } from "@/db";
import { canManageAnyCharacter, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { refreshStandings } from "@/lib/epgp/standings";
import { assignCharacterToUser } from "@/lib/players";
import { getSession } from "@/lib/session";

export type ClaimReviewResult = { error?: string };

export async function approveClaim(claimId: number): Promise<ClaimReviewResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);
  if (!canManageAnyCharacter(role)) {
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
    .select({ ownerId: characters.ownerId })
    .from(characters)
    .where(eq(characters.id, claim.characterId));
  if (!character) return { error: "That character no longer exists." };

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
    await autoDenyOtherPendingClaims(db, claim.characterId, claimId, session.user.id, now);
    return {};
  }

  if (character.ownerId !== null) {
    return {
      error:
        "That character is already owned by another account. Reassign it in Admin → Characters first, or deny this request.",
    };
  }

  // Sets owner_id (re-checking the character is still unclaimed — a benign
  // check-then-write race if two approvals land together), resolves the
  // requester's player and attaches the character to it (PLAN.md §11 Phase
  // 10 task 10.2 — also pulls any stranded ledger history under one
  // identity). Shared with the "assign a character to a member" admin
  // action so the two can't drift.
  const assigned = await assignCharacterToUser(db, claim.characterId, claim.requesterId);
  if (!assigned.ok) return { error: assigned.error };

  await db
    .update(characterClaims)
    .set({ status: "approved", reviewedBy: session.user.id, reviewedAt: now })
    .where(eq(characterClaims.id, claimId));

  // assignCharacterToUser may have absorbed a defunct standalone player
  // (its ledger history moved onto this player), so recompute standings.
  if (assigned.playerId != null) await refreshStandings(db, { playerIds: [assigned.playerId] });

  await autoDenyOtherPendingClaims(db, claim.characterId, claimId, session.user.id, now);

  return {};
}

// Any other still-pending claim on the same character is now moot once one
// is approved (or the character turns out to already be assigned) — deny
// them rather than leaving them stuck pending forever.
async function autoDenyOtherPendingClaims(
  db: Awaited<ReturnType<typeof getDb>>,
  characterId: number,
  approvedClaimId: number,
  reviewedBy: string,
  reviewedAt: Date,
): Promise<void> {
  await db
    .update(characterClaims)
    .set({
      status: "denied",
      decisionNote: "Character was claimed by another member.",
      reviewedBy,
      reviewedAt,
    })
    .where(
      and(
        eq(characterClaims.characterId, characterId),
        eq(characterClaims.status, "pending"),
        ne(characterClaims.id, approvedClaimId),
      ),
    );
}

export async function denyClaim(claimId: number, decisionNote: string): Promise<ClaimReviewResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);
  if (!canManageAnyCharacter(role)) {
    return { error: "Only officers and leaders can review claims." };
  }

  const db = await getDb();
  const [claim] = await db.select({ status: characterClaims.status }).from(characterClaims).where(eq(characterClaims.id, claimId));
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

  return {};
}
