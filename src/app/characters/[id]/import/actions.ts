"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { characterPopFlags, characters, importLog } from "@/db";
import { getDb } from "@/lib/db";
import { deriveCompletion, getFlagById, parseSeer } from "@/lib/pop-flags";
import { getSession } from "@/lib/session";

export type SeerImportState = {
  error?: string;
  result?: {
    detected: number;
    changed: { id: string; label: string; zoneShort: string }[];
  };
};

export async function importSeerText(
  characterId: number,
  _prevState: SeerImportState,
  formData: FormData,
): Promise<SeerImportState> {
  const session = await getSession();
  if (!session) redirect("/login");

  const text = String(formData.get("text") ?? "").trim();
  if (!text) return { error: "Paste the Seer's guided meditation text first." };

  const db = await getDb();
  const [character] = await db.select().from(characters).where(eq(characters.id, characterId));
  if (!character || character.ownerId !== session.user.id) {
    return { error: "You don't have permission to import for this character." };
  }

  const qglobals = parseSeer(text);
  if (Object.keys(qglobals).length === 0) {
    return { error: "Didn't recognize any Seer output in that text — paste the full guided meditation reply." };
  }
  const detectedIds = deriveCompletion(qglobals);

  const existingRows = await db
    .select()
    .from(characterPopFlags)
    .where(eq(characterPopFlags.characterId, characterId));
  const existingByFlag = new Map(existingRows.map((r) => [r.flagId, r]));

  // A manual row (set through the checklist, once task 10 ships) always wins
  // over an automated Seer reading, regardless of which way the member set
  // it — this import path has no way to tell "regressed" from "not printed
  // in this paste."
  const toUpsert = detectedIds.filter((id) => existingByFlag.get(id)?.source !== "manual");
  const changedIds = toUpsert.filter((id) => !existingByFlag.get(id)?.done);

  const now = new Date();
  for (const flagId of toUpsert) {
    await db
      .insert(characterPopFlags)
      .values({ characterId, flagId, done: true, source: "seer", updatedAt: now })
      .onConflictDoUpdate({
        target: [characterPopFlags.characterId, characterPopFlags.flagId],
        set: { done: true, source: "seer", updatedAt: now },
      });
  }

  const summary = `${detectedIds.length} flags detected, ${changedIds.length} changed`;
  await db.insert(importLog).values({
    characterId,
    uploadedBy: session.user.id,
    kind: "seer_text",
    summary,
  });

  return {
    result: {
      detected: detectedIds.length,
      changed: changedIds
        .map((id) => getFlagById(id))
        .filter((f) => f !== undefined)
        .map((f) => ({ id: f.id, label: f.label, zoneShort: f.zone_short })),
    },
  };
}
