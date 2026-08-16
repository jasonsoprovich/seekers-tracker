"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { characterPopFlags, characters } from "@/db";
import { getDb } from "@/lib/db";
import { getFlagById, resolveFlags } from "@/lib/pop-flags";
import { getSession } from "@/lib/session";

export type ToggleFlagResult = { error?: string };

// Mirrors pq-companion's Store.SetManual ordering rules (backend/internal/
// popflag/store.go): a flag can't be manually checked while a prereq is
// unmet, unless it's already effectively done (confirming a Seer/import
// detection on a node whose prereqs aren't tracked); it can't be unchecked
// while a completed later step still depends on it — retraction goes
// top-down.
export async function setManualFlag(
  characterId: number,
  flagId: string,
  done: boolean,
): Promise<ToggleFlagResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const flag = getFlagById(flagId);
  if (!flag) return { error: "Unknown flag." };

  const db = await getDb();
  const [character] = await db.select().from(characters).where(eq(characters.id, characterId));
  if (!character || character.ownerId !== session.user.id) {
    return { error: "You don't have permission to edit this character's flags." };
  }

  const rows = await db
    .select()
    .from(characterPopFlags)
    .where(eq(characterPopFlags.characterId, characterId));
  const resolved = resolveFlags(rows.map((r) => ({ flagId: r.flagId, done: r.done, source: r.source })));

  if (done) {
    const fs = resolved.flags.find((f) => f.id === flagId);
    if (fs?.locked && !fs.done) {
      const missing = (fs.missing ?? []).map((id) => getFlagById(id)?.label ?? id).join(", ");
      return { error: `Complete prerequisites first: ${missing}` };
    }
  } else {
    const blocker = resolved.flags.find((f) => f.done && f.prereqs.includes(flagId));
    if (blocker) {
      return { error: `Required by a completed step: ${blocker.label}` };
    }
  }

  const now = new Date();
  await db
    .insert(characterPopFlags)
    .values({ characterId, flagId, done, source: "manual", updatedAt: now })
    .onConflictDoUpdate({
      target: [characterPopFlags.characterId, characterPopFlags.flagId],
      set: { done, source: "manual", updatedAt: now },
    });

  return {};
}
