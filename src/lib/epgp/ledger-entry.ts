import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { characters, epLedger, gpLedger } from "@/db";
import { getSettingAt } from "@/lib/epgp/settings";
import { invalidateEpgpTotalsCache } from "@/lib/epgp/totals";

// Shared by the website's manual-entry Server Action
// (src/app/(app)/epgp/ledger/actions.ts) and the officer app's
// POST /api/officer/manual-entry route — one place that decides what makes
// a valid ep_ledger/gp_ledger row, so the two calling conventions
// (redirect-on-no-session vs. JSON error response) can't drift into
// different validation rules. Callers are responsible for their own
// auth/permission check before calling this — it only validates the row
// shape and inserts.
export type LedgerEntrySource = "manual" | "parse";

export type InsertLedgerEntryInput =
  | { kind: "ep"; characterId: number; activity: string; points: number; occurredAt: string; note: string; zone?: string | null }
  | { kind: "gp"; characterId: number; tier: string; itemName: string; points: number; occurredAt: string; note: string };

export type InsertLedgerEntryResult = { ok: true } | { ok: false; error: string };

function parseOccurredAt(raw: string): Date | null {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function insertLedgerEntry(
  db: ReturnType<typeof drizzle>,
  input: InsertLedgerEntryInput,
  enteredBy: string,
  source: LedgerEntrySource = "manual",
): Promise<InsertLedgerEntryResult> {
  if (!Number.isFinite(input.points)) return { ok: false, error: "Points must be a number." };
  const occurredAt = parseOccurredAt(input.occurredAt);
  if (!occurredAt) return { ok: false, error: "Invalid date." };
  const activityOrTier = (input.kind === "ep" ? input.activity : input.tier).trim();
  if (!activityOrTier) return { ok: false, error: input.kind === "ep" ? "Activity is required." : "Tier is required." };

  const [character] = await db
    .select({ id: characters.id, charType: characters.charType, mainCharacterId: characters.mainCharacterId, playerId: characters.playerId })
    .from(characters)
    .where(eq(characters.id, input.characterId));
  if (!character) return { ok: false, error: "Character not found." };

  // EPGP is tracked entirely per main (docs §10 — alts are informational,
  // not rankable) and computeEpgpTotals groups strictly by raw
  // character_id with no alt->main collapsing of its own; the roster
  // page's display-time redirect (totalsFor) only shows a main's totals,
  // so a row landing on an alt's own id would be invisible there. Redirect
  // here, once, so every caller (this site's form, the officer app's
  // manual-entry/attendance/bids routes) gets it for free.
  const targetCharacterId = character.charType === "alt" && character.mainCharacterId !== null ? character.mainCharacterId : character.id;

  // An alt shares its player's player_id (Phase 3's derivation groups every
  // character of a player under one players row regardless of main/alt/mule),
  // so the alt's own playerId is already correct here without re-querying
  // the target/main character.
  const playerId = character.playerId;

  if (input.kind === "ep") {
    // computeEpgpTotals (Phase 3 task 3.11) groups by ep_ledger.player_id,
    // not character_id — a row written with player_id left NULL is
    // invisible in every total the same way an orphaned import row is.
    // points_nominal/points_awarded/cap_applied/cap_at_entry mirror
    // scripts/import-epgp.ts's columns (§2) so a row written here answers
    // the same "why did this award land at X" questions as an imported one.
    // Write-time cap *clamping* (the running per-cycle sum in §2) isn't
    // implemented yet — it depends on cycle management, which PLAN.md §16
    // lists as still an open decision — so nominal/awarded are equal and
    // cap_applied is always false here; only cap_at_entry (today's cap
    // setting) is recorded for later reference.
    const capAtEntryRaw = await getSettingAt(db, "ep_cap_per_cycle", occurredAt);
    await db.insert(epLedger).values({
      characterId: targetCharacterId,
      playerId,
      occurredAt,
      activity: activityOrTier,
      points: input.points,
      pointsNominal: input.points,
      pointsAwarded: input.points,
      capApplied: false,
      capAtEntry: capAtEntryRaw !== null ? Number(capAtEntryRaw) : null,
      note: input.note.trim() || null,
      zone: input.zone?.trim() || null,
      enteredBy,
      source,
    });
  } else {
    await db.insert(gpLedger).values({
      characterId: targetCharacterId,
      playerId,
      occurredAt,
      itemName: input.itemName.trim() || null,
      tier: activityOrTier,
      points: input.points,
      pointsNominal: input.points,
      pointsAwarded: input.points,
      capApplied: false,
      capAtEntry: null,
      note: input.note.trim() || null,
      enteredBy,
      source,
    });
  }

  // Every EPGP-affecting write goes through this function (website form,
  // officer manual-entry/attendance/bids routes), so invalidating here once
  // covers every caller instead of each one remembering to do it.
  await invalidateEpgpTotalsCache();

  return { ok: true };
}
