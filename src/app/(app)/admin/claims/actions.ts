"use server";

import { and, eq, ne } from "drizzle-orm";
import { redirect } from "next/navigation";

import { characterClaims, characters } from "@/db";
import { canManageAnyCharacter, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
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

  // Re-check the character is still unclaimed — a check-then-write race if
  // two claims on the same character are approved back to back (same benign
  // race acknowledged for the character-name uniqueness check and
  // bootstrap-leader's claim).
  const [character] = await db.select({ ownerId: characters.ownerId }).from(characters).where(eq(characters.id, claim.characterId));
  if (!character) return { error: "That character no longer exists." };
  if (character.ownerId !== null) return { error: "That character has already been claimed by someone else." };

  const now = new Date();
  await db.update(characters).set({ ownerId: claim.requesterId, updatedAt: now }).where(eq(characters.id, claim.characterId));
  await db
    .update(characterClaims)
    .set({ status: "approved", reviewedBy: session.user.id, reviewedAt: now })
    .where(eq(characterClaims.id, claimId));

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
