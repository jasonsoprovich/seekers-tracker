"use server";

import { eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
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
import { recordPopFlagEvent } from "@/lib/system-log/pop-flags";

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
  await recordPopFlagEvent(db, session.user.id, character, "flags.import", `Seer import — ${summary}`, { kind: "seer_text" });

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
  await recordPopFlagEvent(db, session.user.id, character, "flags.import", `#popflags import — ${summary}`, { kind: "popflags_text" });

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

// One character's planned changes from a pq-companion export.
export type PqCharacterPreview = {
  characterId: number;
  characterName: string;
  toMarkDone: PqFlagRef[];
  toUnmark: PqFlagRef[];
  // Manual rows whose state differs from the export; only applied when the
  // member opts in to overwriting their manual settings.
  manualConflicts: (PqFlagRef & { exportDone: boolean })[];
  unknown: number;
  exportFlagCount: number;
};

export type PqCharacterResult = {
  characterName: string;
  markedDone: PqFlagRef[];
  unmarked: PqFlagRef[];
  overwroteManual: number;
  keptManual: number;
  unknown: number;
};

// An export entry that won't be imported, and why.
export type PqSkipped = { name: string; reason: string };

export type PqExportImportState = {
  error?: string;
  // Step 1 (preview): nothing written yet. `json` is echoed back so the apply
  // step submits exactly what was previewed.
  preview?: { json: string; characters: PqCharacterPreview[]; skipped: PqSkipped[] };
  result?: { characters: PqCharacterResult[]; skipped: PqSkipped[] };
};

// 5 bound params per upsert row (character_id, flag_id, done, source,
// updated_at); 18 rows = 90, under D1's 100-param statement cap.
const PQC_UPSERT_CHUNK = 18;
// IN-list size cap (CLAUDE.md: keep IN lists ≤ 90).
const PQC_IN_CHUNK = 90;

// pq-companion's PoP Flagging export (see src/lib/pop-flags/pqc-export.ts).
// The file covers every character on the exporting PC (its "All" tab), so
// one import updates every entry that matches a roster character the
// importer can manage — not just this page's character. Entries with no
// roster match, or someone else's character, are listed as skipped; nothing
// is ever created. It's a full sync of pq-companion's resolved state
// (done=false also applies), so it can un-check flags: the preview lists
// those and the apply step refuses to run until the member confirms them. A
// manual row on the site wins by default; where it differs from the export
// the preview offers an explicit "overwrite my manual settings" opt-in.
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
  const [pageCharacter] = await db.select().from(characters).where(eq(characters.id, characterId));
  if (!pageCharacter || !(await canManageCharacter(pageCharacter, session.user.id))) {
    return { error: "You don't have permission to import for this character." };
  }

  const parsed = parsePqExport(raw);
  if ("error" in parsed) return { error: parsed.error };

  // Resolve every export name to a roster character (names are unique,
  // case-insensitive — see characters_name_unique).
  const lowerNames = [...new Set(parsed.data.characters.map((c) => c.name.toLowerCase()))];
  const rosterByName = new Map<string, typeof characters.$inferSelect>();
  for (let i = 0; i < lowerNames.length; i += PQC_IN_CHUNK) {
    const rows = await db
      .select()
      .from(characters)
      .where(inArray(sql`lower(${characters.name})`, lowerNames.slice(i, i + PQC_IN_CHUNK)));
    for (const r of rows) rosterByName.set(r.name.toLowerCase(), r);
  }

  const skipped: PqSkipped[] = [];
  const targets: { character: typeof characters.$inferSelect; entry: (typeof parsed.data.characters)[number] }[] = [];
  const seen = new Set<number>();
  for (const entry of parsed.data.characters) {
    const character = rosterByName.get(entry.name.toLowerCase());
    if (!character) {
      skipped.push({ name: entry.name, reason: "not on the roster" });
      continue;
    }
    if (seen.has(character.id)) continue;
    if (!(await canManageCharacter(character, session.user.id))) {
      skipped.push({ name: character.name, reason: "not a character you can edit" });
      continue;
    }
    seen.add(character.id);
    targets.push({ character, entry });
  }
  if (targets.length === 0) {
    return { error: `None of the characters in this export are ones you can import for (it contains: ${parsed.data.characters.map((c) => c.name).join(", ")}).` };
  }
  // This page's character first, then alphabetical.
  targets.sort((a, b) => Number(b.character.id === characterId) - Number(a.character.id === characterId) || a.character.name.localeCompare(b.character.name));

  const targetIds = targets.map((t) => t.character.id);
  const existingRows: (typeof characterPopFlags.$inferSelect)[] = [];
  for (let i = 0; i < targetIds.length; i += PQC_IN_CHUNK) {
    existingRows.push(
      ...(await db.select().from(characterPopFlags).where(inArray(characterPopFlags.characterId, targetIds.slice(i, i + PQC_IN_CHUNK)))),
    );
  }

  const previews: PqCharacterPreview[] = targets.map(({ character, entry }) => {
    const existingByFlag = new Map(existingRows.filter((r) => r.characterId === character.id).map((r) => [r.flagId, r]));
    const preview: PqCharacterPreview = {
      characterId: character.id,
      characterName: character.name,
      toMarkDone: [],
      toUnmark: [],
      manualConflicts: [],
      unknown: 0,
      exportFlagCount: entry.flags.length,
    };
    for (const flag of entry.flags) {
      const dataset = getFlagById(flag.flagId);
      if (!dataset) {
        preview.unknown++;
        continue;
      }
      const existing = existingByFlag.get(flag.flagId);
      const ref = { id: dataset.id, label: dataset.label, zoneShort: dataset.zone_short };
      if (existing?.source === "manual") {
        if (existing.done !== flag.done) preview.manualConflicts.push({ ...ref, exportDone: flag.done });
        continue;
      }
      if (flag.done && !existing?.done) preview.toMarkDone.push(ref);
      else if (!flag.done && existing?.done) preview.toUnmark.push(ref);
    }
    return preview;
  });

  if (intent !== "apply") {
    return { preview: { json: raw, characters: previews, skipped } };
  }

  const totalUnmark = previews.reduce((n, p) => n + p.toUnmark.length, 0);
  if (totalUnmark > 0 && formData.get("confirmUnmark") !== "on") {
    return {
      error: `This import would un-check ${totalUnmark} flag${totalUnmark === 1 ? "" : "s"}. Preview again and tick the confirmation box to proceed.`,
      preview: { json: raw, characters: previews, skipped },
    };
  }

  // Manual rows only change on explicit opt-in.
  const overwriteManual = formData.get("overwriteManual") === "on";
  const now = new Date();
  const upserts: { characterId: number; flagId: string; done: boolean }[] = [];
  for (const p of previews) {
    const overwrite = overwriteManual ? p.manualConflicts : [];
    for (const r of p.toMarkDone) upserts.push({ characterId: p.characterId, flagId: r.id, done: true });
    for (const r of p.toUnmark) upserts.push({ characterId: p.characterId, flagId: r.id, done: false });
    for (const r of overwrite) upserts.push({ characterId: p.characterId, flagId: r.id, done: r.exportDone });
  }
  if (upserts.length > 0) {
    const stmts: BatchItem<"sqlite">[] = [];
    for (let i = 0; i < upserts.length; i += PQC_UPSERT_CHUNK) {
      stmts.push(
        db
          .insert(characterPopFlags)
          .values(upserts.slice(i, i + PQC_UPSERT_CHUNK).map((u) => ({ ...u, source: "import" as const, updatedAt: now })))
          .onConflictDoUpdate({
            target: [characterPopFlags.characterId, characterPopFlags.flagId],
            set: { done: sql`excluded.done`, source: "import", updatedAt: now },
          }),
      );
    }
    await db.batch(stmts as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  }

  // One archived copy of the file; each character gets its own import_log
  // row and System Log entry pointing at it.
  const r2Key = await archiveImportPayload("pqc_export", characterId, raw);
  const results: PqCharacterResult[] = [];
  for (const [i, p] of previews.entries()) {
    const overwrite = overwriteManual ? p.manualConflicts : [];
    const keptManual = p.manualConflicts.length - overwrite.length;
    const summary = `${p.exportFlagCount} flags in export, ${p.toMarkDone.length} marked done, ${p.toUnmark.length} un-checked, ${overwrite.length} manual overwritten, ${keptManual} kept manual, ${p.unknown} unknown`;
    await db.insert(importLog).values({ characterId: p.characterId, uploadedBy: session.user.id, kind: "pqc_export", r2Key, summary });
    await recordPopFlagEvent(db, session.user.id, targets[i]!.character, "flags.import", `pq-companion import — ${summary}`, {
      kind: "pqc_export",
      charactersInImport: previews.length,
    });
    results.push({
      characterName: p.characterName,
      markedDone: [...p.toMarkDone, ...overwrite.filter((r) => r.exportDone)],
      unmarked: [...p.toUnmark, ...overwrite.filter((r) => !r.exportDone)],
      overwroteManual: overwrite.length,
      keptManual,
      unknown: p.unknown,
    });
  }

  return { result: { characters: results, skipped } };
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
