"use server";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { characterClaims, characters } from "@/db";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";

export type ClaimActionState = { error?: string };

// Same cause-chain walk as characters/actions.ts's isUniqueConstraintError —
// D1's driver wraps the SQLite error rather than surfacing it typed.
function isUniqueConstraintError(err: unknown): boolean {
  for (let cause = err; cause instanceof Error; cause = cause.cause) {
    if (/UNIQUE constraint failed/i.test(cause.message)) return true;
  }
  return false;
}

// Requests to attach an unclaimed roster character (owner_id NULL) to the
// current account. Never sets ownerId directly — that only happens on
// officer approval (admin/claims/actions.ts) — so a pending or denied claim
// leaves the character untouched, and two different members can each have
// an outstanding claim on the same character for an officer to arbitrate.
export async function requestClaim(characterId: number, note: string): Promise<ClaimActionState> {
  const session = await getSession();
  if (!session) redirect("/login");

  if (!Number.isInteger(characterId) || characterId <= 0) return { error: "Invalid character." };
  const trimmedNote = note.trim().slice(0, 500) || null;

  const db = await getDb();
  const [character] = await db.select({ ownerId: characters.ownerId }).from(characters).where(eq(characters.id, characterId));
  if (!character) return { error: "That character no longer exists." };
  if (character.ownerId !== null) return { error: "That character has already been claimed." };

  const [existingPending] = await db
    .select({ id: characterClaims.id })
    .from(characterClaims)
    .where(
      and(
        eq(characterClaims.characterId, characterId),
        eq(characterClaims.requesterId, session.user.id),
        eq(characterClaims.status, "pending"),
      ),
    );
  if (existingPending) return { error: "You already have a pending claim for this character." };

  try {
    await db.insert(characterClaims).values({ characterId, requesterId: session.user.id, note: trimmedNote });
  } catch (err) {
    if (isUniqueConstraintError(err)) return { error: "You already have a pending claim for this character." };
    throw err;
  }

  return {};
}
