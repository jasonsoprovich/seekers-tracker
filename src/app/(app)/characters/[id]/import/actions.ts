"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { characterGear, characterPopFlags, characters, characterStats, importLog } from "@/db";
import { canManageCharacter } from "@/lib/permissions";
import { computeDerivedStats } from "@/lib/eqstat";
import { getDb } from "@/lib/db";
import { getItemIcon, gearSlotLabel, parseQuarmyGear, parseQuarmyStats } from "@/lib/gear";
import { archiveImportPayload } from "@/lib/import-archive";
import {
  deriveCompletion,
  extractPopFlagsBlocks,
  getFlagById,
  mergeReportsToQglobals,
  parsePopFlagsReport,
  parsePqExport,
  parseSeer,
} from "@/lib/pop-flags";
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
  if (!character || !(await canManageCharacter(character, session.user.id))) {
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

export type PopFlagsImportState = {
  error?: string;
  result?: {
    sections: string[];
    detected: number;
    changed: { id: string; label: string; zoneShort: string }[];
    keptManual: number;
    pendingMemories: number;
  };
};

// Applies pasted '#popflags' output (with or without EQ log timestamps; can
// contain several reports at once — overview, tiers 1-4, Plane of Time).
// ADDITIVE ONLY: a report can only mark flags done, never un-mark one, and a
// manual row (checked/unchecked by the member) is never overwritten — so
// existing progress is never wiped or reset by an import.
export async function importPopFlagsText(
  characterId: number,
  _prevState: PopFlagsImportState,
  formData: FormData,
): Promise<PopFlagsImportState> {
  const session = await getSession();
  if (!session) redirect("/login");

  const text = String(formData.get("text") ?? "").trim();
  if (!text) return { error: "Paste your #popflags output first." };

  const db = await getDb();
  const [character] = await db.select().from(characters).where(eq(characters.id, characterId));
  if (!character || !(await canManageCharacter(character, session.user.id))) {
    return { error: "You don't have permission to import for this character." };
  }

  const blocks = extractPopFlagsBlocks(text);
  if (blocks.length === 0) {
    return {
      error:
        'Didn\'t find any #popflags output. Run #popflags (and #popflags 1 through 4) in game, then copy those lines from your log — they start with "=== Planes of Power Progression ===" or "=== Tier N Progression ===".',
    };
  }
  const reports = blocks.map(parsePopFlagsReport);
  const detectedIds = deriveCompletion(mergeReportsToQglobals(reports));

  const existingRows = await db
    .select()
    .from(characterPopFlags)
    .where(eq(characterPopFlags.characterId, characterId));
  const existingByFlag = new Map(existingRows.map((r) => [r.flagId, r]));

  const keptManual = detectedIds.filter((id) => existingByFlag.get(id)?.source === "manual").length;
  const toUpsert = detectedIds.filter((id) => existingByFlag.get(id)?.source !== "manual");
  const changedIds = toUpsert.filter((id) => !existingByFlag.get(id)?.done);

  const now = new Date();
  for (const flagId of changedIds) {
    await db
      .insert(characterPopFlags)
      .values({ characterId, flagId, done: true, source: "seer", updatedAt: now })
      .onConflictDoUpdate({
        target: [characterPopFlags.characterId, characterPopFlags.flagId],
        set: { done: true, source: "seer", updatedAt: now },
      });
  }

  const sections = [...new Set(reports.map((r) => r.section).filter((s): s is NonNullable<typeof s> => !!s))];
  const pendingMemories = new Set(reports.flatMap((r) => Object.keys(r.pending))).size;
  const summary = `${blocks.length} report(s) [${sections.join(", ")}], ${detectedIds.length} flags detected, ${changedIds.length} changed`;
  const r2Key = await archiveImportPayload("popflags_text", characterId, text);
  await db.insert(importLog).values({
    characterId,
    uploadedBy: session.user.id,
    kind: "popflags_text",
    r2Key,
    summary,
  });

  return {
    result: {
      sections,
      detected: detectedIds.length,
      changed: changedIds
        .map((id) => getFlagById(id))
        .filter((f) => f !== undefined)
        .map((f) => ({ id: f.id, label: f.label, zoneShort: f.zone_short })),
      keptManual,
      pendingMemories,
    },
  };
}

type PqFlagRef = { id: string; label: string; zoneShort: string };

export type PqExportImportState = {
  error?: string;
  // Step 1 (preview): nothing written yet. `json` is echoed back so the apply
  // step submits exactly what was previewed.
  preview?: {
    json: string;
    characterName: string;
    toMarkDone: PqFlagRef[];
    toUnmark: PqFlagRef[];
    keptManual: number;
    unknown: number;
  };
  result?: {
    characterName: string;
    markedDone: PqFlagRef[];
    unmarked: PqFlagRef[];
    keptManual: number;
    unknown: number;
  };
};

// pq-companion's PoP Flagging export (see src/lib/pop-flags/pqc-export.ts).
// The file covers every character on the exporting PC; only the entry whose
// name matches THIS page's character is used — nothing else is read or
// created. It's a full sync of pq-companion's resolved state (done=false also
// applies), so it can un-check flags: the preview lists those and the apply
// step refuses to run until the member confirms them. A manual row on the
// site always wins and is never touched (same precedence as the other
// imports).
export async function importPqCompanionExport(
  characterId: number,
  _prevState: PqExportImportState,
  formData: FormData,
): Promise<PqExportImportState> {
  const session = await getSession();
  if (!session) redirect("/login");

  const intent = String(formData.get("intent") ?? "preview");
  const raw = String(formData.get(intent === "apply" ? "applyJson" : "json") ?? "").trim();
  if (!raw) return { error: "Choose or paste the exported JSON first." };

  const db = await getDb();
  const [character] = await db.select().from(characters).where(eq(characters.id, characterId));
  if (!character || !(await canManageCharacter(character, session.user.id))) {
    return { error: "You don't have permission to import for this character." };
  }

  const parsed = parsePqExport(raw);
  if ("error" in parsed) return { error: parsed.error };

  const wanted = character.name.trim().toLowerCase();
  const entry = parsed.data.characters.find((c) => c.name.toLowerCase() === wanted);
  if (!entry) {
    const names = parsed.data.characters.map((c) => c.name).join(", ");
    return {
      error: `"${character.name}" isn't in this export (it contains: ${names}). Open the Import page of the character you want to import.`,
    };
  }

  const existingRows = await db
    .select()
    .from(characterPopFlags)
    .where(eq(characterPopFlags.characterId, characterId));
  const existingByFlag = new Map(existingRows.map((r) => [r.flagId, r]));

  let keptManual = 0;
  let unknown = 0;
  const toMarkDone: PqFlagRef[] = [];
  const toUnmark: PqFlagRef[] = [];
  for (const flag of entry.flags) {
    const dataset = getFlagById(flag.flagId);
    if (!dataset) {
      unknown++;
      continue;
    }
    const existing = existingByFlag.get(flag.flagId);
    if (existing?.source === "manual") {
      if (existing.done !== flag.done) keptManual++;
      continue;
    }
    const ref = { id: dataset.id, label: dataset.label, zoneShort: dataset.zone_short };
    if (flag.done && !existing?.done) toMarkDone.push(ref);
    else if (!flag.done && existing?.done) toUnmark.push(ref);
  }

  if (intent !== "apply") {
    return {
      preview: { json: raw, characterName: character.name, toMarkDone, toUnmark, keptManual, unknown },
    };
  }

  if (toUnmark.length > 0 && formData.get("confirmUnmark") !== "on") {
    return {
      error: `This import would un-check ${toUnmark.length} flag${toUnmark.length === 1 ? "" : "s"}. Preview again and tick the confirmation box to proceed.`,
      preview: { json: raw, characterName: character.name, toMarkDone, toUnmark, keptManual, unknown },
    };
  }

  const now = new Date();
  for (const [ref, done] of [
    ...toMarkDone.map((r) => [r, true] as const),
    ...toUnmark.map((r) => [r, false] as const),
  ]) {
    await db
      .insert(characterPopFlags)
      .values({ characterId, flagId: ref.id, done, source: "import", updatedAt: now })
      .onConflictDoUpdate({
        target: [characterPopFlags.characterId, characterPopFlags.flagId],
        set: { done, source: "import", updatedAt: now },
      });
  }

  const summary = `${entry.flags.length} flags in export, ${toMarkDone.length} marked done, ${toUnmark.length} un-checked, ${keptManual} kept manual, ${unknown} unknown`;
  const r2Key = await archiveImportPayload("pqc_export", characterId, raw);
  await db.insert(importLog).values({
    characterId,
    uploadedBy: session.user.id,
    kind: "pqc_export",
    r2Key,
    summary,
  });

  return { result: { characterName: character.name, markedDone: toMarkDone, unmarked: toUnmark, keptManual, unknown } };
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
  if (!character || !(await canManageCharacter(character, session.user.id))) {
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
