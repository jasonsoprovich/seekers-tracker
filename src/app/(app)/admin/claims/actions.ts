"use server";

import { and, eq, ne } from "drizzle-orm";
import { redirect } from "next/navigation";

import { characterClaims } from "@/db";
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

  // Sets owner_id (re-checking the character is still unclaimed — a benign
  // check-then-write race if two approvals land together), resolves the
  // requester's player and attaches the character to it (PLAN.md §11 Phase
  // 10 task 10.2 — also pulls any stranded ledger history under one
  // identity). Shared with the "assign a character to a member" admin
  // action so the two can't drift.
  const assigned = await assignCharacterToUser(db, claim.characterId, claim.requesterId);
  if (!assigned.ok) return { error: assigned.error };

  const now = new Date();
  await db
    .update(characterClaims)
    .set({ status: "approved", reviewedBy: session.user.id, reviewedAt: now })
    .where(eq(characterClaims.id, claimId));

  // assignCharacterToUser may have absorbed a defunct standalone player
  // (its ledger history moved onto this player), so recompute standings.
  if (assigned.playerId != null) await refreshStandings(db, { playerIds: [assigned.playerId] });

  // Any other still-pending claim on this character (from a different
  // requester) is now moot — auto-deny it rather than leaving it stuck
  // pending forever.
  await db
    .update(characterClaims)
    .set({
      status: "denied",
      decisionNote: "Character was claimed by another member.",
      reviewedBy: session.user.id,
      reviewedAt: now,
    })
    .where(
      and(eq(characterClaims.characterId, claim.characterId), eq(characterClaims.status, "pending"), ne(characterClaims.id, claimId)),
    );

  return {};
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
