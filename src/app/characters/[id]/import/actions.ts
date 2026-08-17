"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { characterGear, characterPopFlags, characters, characterStats, importLog } from "@/db";
import { computeDerivedStats } from "@/lib/eqstat";
import { getDb } from "@/lib/db";
import { getItemIcon, gearSlotLabel, parseQuarmyGear, parseQuarmyStats } from "@/lib/gear";
import { archiveImportPayload } from "@/lib/import-archive";
import { deriveCompletion, getFlagById, parsePqExport, parseSeer } from "@/lib/pop-flags";
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
  const r2Key = await archiveImportPayload("seer_text", characterId, text);
  await db.insert(importLog).values({
    characterId,
    uploadedBy: session.user.id,
    kind: "seer_text",
    r2Key,
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

export type PqExportImportState = {
  error?: string;
  result?: {
    total: number;
    changed: { id: string; label: string; zoneShort: string; done: boolean }[];
    skippedManual: number;
    skippedUnknown: number;
  };
};

// Task 14: the "preferred once available" import path from §6 — a
// pq-companion "Export Guild Progress" JSON, not yet built on pq-companion's
// side (see src/lib/pop-flags/pqc-export.ts). Unlike importSeerText above,
// this is a full sync of pq-companion's resolved per-flag state (both
// done=true and done=false are meaningful and applied), not an additive-only
// signal — pq-companion has already done the resolution work.
export async function importPqCompanionExport(
  characterId: number,
  _prevState: PqExportImportState,
  formData: FormData,
): Promise<PqExportImportState> {
  const session = await getSession();
  if (!session) redirect("/login");

  const raw = String(formData.get("json") ?? "").trim();
  if (!raw) return { error: "Paste the exported JSON first." };

  const db = await getDb();
  const [character] = await db.select().from(characters).where(eq(characters.id, characterId));
  if (!character || character.ownerId !== session.user.id) {
    return { error: "You don't have permission to import for this character." };
  }

  const parsed = parsePqExport(raw);
  if ("error" in parsed) return { error: parsed.error };
  const { data } = parsed;

  if (data.characterName.trim().toLowerCase() !== character.name.trim().toLowerCase()) {
    return {
      error: `This export is for "${data.characterName}", but you're importing to "${character.name}". Paste the right character's export.`,
    };
  }

  const existingRows = await db
    .select()
    .from(characterPopFlags)
    .where(eq(characterPopFlags.characterId, characterId));
  const existingByFlag = new Map(existingRows.map((r) => [r.flagId, r]));

  let skippedManual = 0;
  let skippedUnknown = 0;
  const changed: { id: string; label: string; zoneShort: string; done: boolean }[] = [];
  const now = new Date();

  for (const flag of data.flags) {
    const dataset = getFlagById(flag.flagId);
    if (!dataset) {
      skippedUnknown++;
      continue;
    }
    // A local manual override (set through the checklist) always wins over
    // an imported reading, same precedence as importSeerText.
    const existing = existingByFlag.get(flag.flagId);
    if (existing?.source === "manual") {
      skippedManual++;
      continue;
    }
    if (existing && existing.done === flag.done) continue;

    await db
      .insert(characterPopFlags)
      .values({ characterId, flagId: flag.flagId, done: flag.done, source: "import", updatedAt: now })
      .onConflictDoUpdate({
        target: [characterPopFlags.characterId, characterPopFlags.flagId],
        set: { done: flag.done, source: "import", updatedAt: now },
      });
    changed.push({ id: dataset.id, label: dataset.label, zoneShort: dataset.zone_short, done: flag.done });
  }

  const summary = `${data.flags.length} flags in export, ${changed.length} changed, ${skippedManual} kept manual, ${skippedUnknown} unknown`;
  const r2Key = await archiveImportPayload("pqc_export", characterId, raw);
  await db.insert(importLog).values({
    characterId,
    uploadedBy: session.user.id,
    kind: "pqc_export",
    r2Key,
    summary,
  });

  return {
    result: {
      total: data.flags.length,
      changed,
      skippedManual,
      skippedUnknown,
    },
  };
}

export type GearImportState = {
  error?: string;
  result?: {
    total: number;
    items: { slot: string; slotLabel: string; itemName: string }[];
  };
};

// Task 16 (§8 Phase 2): a Zeal `<CharName>-Quarmy.txt` export, pasted
// whole. Unlike the PoP-flag imports above, gear has no manual-override
// concept — a member's current loadout fully replaces the last import, so
// unequipped items don't linger as stale rows.
export async function importGear(
  characterId: number,
  _prevState: GearImportState,
  formData: FormData,
): Promise<GearImportState> {
  const session = await getSession();
  if (!session) redirect("/login");

  const text = String(formData.get("text") ?? "").trim();
  if (!text) return { error: "Paste the Quarmy export text first." };

  const db = await getDb();
  const [character] = await db.select().from(characters).where(eq(characters.id, characterId));
  if (!character || character.ownerId !== session.user.id) {
    return { error: "You don't have permission to import for this character." };
  }

  const entries = parseQuarmyGear(text);
  if (entries.length === 0) {
    return {
      error: "Didn't recognize any worn equipment in that text — paste the full Quarmy.txt export contents.",
    };
  }

  const now = new Date();
  await db.delete(characterGear).where(eq(characterGear.characterId, characterId));
  for (const entry of entries) {
    await db.insert(characterGear).values({
      characterId,
      slot: entry.slot,
      itemId: entry.itemId,
      itemName: entry.itemName,
      icon: getItemIcon(entry.itemId) ?? null,
      updatedAt: now,
    });
  }

  // Task 18 (§8 Phase 3): the export's character-stats row carries base
  // attributes, the one derived-stat input this app has no other source
  // for. Older exports (pre-Zeal-1.4.3, or a hand-trimmed paste) may lack
  // it — derived stats just stay unavailable until a fuller export is
  // imported, same graceful-partial approach as the AA/tradeskill sections.
  const baseAttrs = parseQuarmyStats(text);
  if (baseAttrs) {
    const computed = computeDerivedStats({
      class: character.class,
      level: character.level,
      race: character.race,
      base: baseAttrs,
      itemIds: entries.map((e) => e.itemId),
    });
    await db
      .insert(characterStats)
      .values({
        characterId,
        baseStr: baseAttrs.str,
        baseSta: baseAttrs.sta,
        baseCha: baseAttrs.cha,
        baseDex: baseAttrs.dex,
        baseInt: baseAttrs.int,
        baseAgi: baseAttrs.agi,
        baseWis: baseAttrs.wis,
        computedJson: JSON.stringify(computed),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: characterStats.characterId,
        set: {
          baseStr: baseAttrs.str,
          baseSta: baseAttrs.sta,
          baseCha: baseAttrs.cha,
          baseDex: baseAttrs.dex,
          baseInt: baseAttrs.int,
          baseAgi: baseAttrs.agi,
          baseWis: baseAttrs.wis,
          computedJson: JSON.stringify(computed),
          updatedAt: now,
        },
      });
  }

  const r2Key = await archiveImportPayload("gear_export", characterId, text);
  await db.insert(importLog).values({
    characterId,
    uploadedBy: session.user.id,
    kind: "gear_export",
    r2Key,
    summary: `${entries.length} worn items imported`,
  });

  return {
    result: {
      total: entries.length,
      items: entries.map((e) => ({ slot: e.slot, slotLabel: gearSlotLabel(e.slot), itemName: e.itemName })),
    },
  };
}
