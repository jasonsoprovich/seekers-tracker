import { and, eq, inArray, ne } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import * as schema from "@/db";
import { characterClaims, characters } from "@/db";

type Db = ReturnType<typeof drizzle<typeof schema>>;

// Remediation plan Phase 5 (2026-09-13) — account-level character claims.
// Pulled out of admin/claims/actions.ts's "use server" approveClaim so the
// actual resolution logic is reachable from a verification script without
// going through a Next Server Action (same reason players.ts's
// removePlayerFromGuildCore/reinstatePlayerFromGuildCore were split out —
// see that file's own comment).
//
// Any other still-pending claim on the same main/alt/mule group is now moot
// once one claim in it is approved — every character in the group just got
// (or already had) the same owner, so a sibling claim by the SAME requester
// is redundant (task 5.7: mark it approved, same as approveClaim's own
// "already assigned" case) and one by a DIFFERENT requester is now
// unfulfillable (task 5.5: deny it, rather than leaving it stuck pending
// forever — denying preserves the row as history, it's never deleted).
// Falls back to just the one claimed character if it has no player group to
// look up (defensive — every claimable roster character has had player_id
// since PLAN.md §11 Phase 3).
export async function resolveOtherPendingClaimsForGroup(
  db: Db,
  playerId: number | null,
  claimedCharacterId: number,
  approvedRequesterId: string,
  approvedClaimId: number,
  reviewedBy: string,
  reviewedAt: Date,
): Promise<void> {
  const groupCharacterIds =
    playerId != null
      ? (await db.select({ id: characters.id }).from(characters).where(eq(characters.playerId, playerId))).map((c) => c.id)
      : [claimedCharacterId];
  if (groupCharacterIds.length === 0) return;

  const otherPending = await db
    .select({ id: characterClaims.id, requesterId: characterClaims.requesterId })
    .from(characterClaims)
    .where(
      and(
        inArray(characterClaims.characterId, groupCharacterIds),
        eq(characterClaims.status, "pending"),
        ne(characterClaims.id, approvedClaimId),
      ),
    );

  for (const other of otherPending) {
    const sameRequester = other.requesterId === approvedRequesterId;
    await db
      .update(characterClaims)
      .set({
        status: sameRequester ? "approved" : "denied",
        decisionNote: sameRequester ? "Character was already assigned to this member." : "Character was claimed by another member.",
        reviewedBy,
        reviewedAt,
      })
      .where(eq(characterClaims.id, other.id));
  }
}
