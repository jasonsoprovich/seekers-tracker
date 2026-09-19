"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { epLedger, gpLedger, ledgerAuditLog } from "@/db";
import { getDb } from "@/lib/db";
import { recomputeCharacterLastActivity } from "@/lib/epgp/character-activity";
import { recordLedgerChange } from "@/lib/epgp/ledger-audit";
import { insertLedgerEntry, type InsertLedgerEntryInput } from "@/lib/epgp/ledger-entry";
import { getStandingsForPlayers, markStandingsDirty, settleStandings, type StandingsRow } from "@/lib/epgp/standings";
import { ATTENDANCE_GATED_ACTIVITIES } from "@/lib/epgp/attendance";
import { guildDayBounds } from "@/lib/guild-timezone";
import { getPermissions } from "@/lib/permissions";
import { getSession } from "@/lib/session";
import { boundedString } from "@/lib/validate";

// `standing` (task 4.3) is the affected player's just-refreshed row, fetched
// fresh (getStandingsForPlayers, never the roster-wide 10s cache) — present
// on a successful mutation that touched a player with a totals row; null/
// absent otherwise (no error implied either way).
export type LedgerActionResult = { error?: string; standing?: StandingsRow | null };

export type AddLedgerEntryInput = InsertLedgerEntryInput;

export type UpdateLedgerEntryInput =
  | { kind: "ep"; id: number; activity: string; points: number; occurredAt: string; note: string; zone: string; raidDate: string }
  | { kind: "gp"; id: number; tier: string; itemName: string; points: number; occurredAt: string; note: string };

function parseOccurredAt(raw: string): Date | null {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Manual ledger entries (guild-bank buys/donations, ad-hoc adjustments,
// error correction) — the only current way to write ep_ledger/gp_ledger
// rows outside of the one-off scripts/import-epgp.ts seed. Same
// officer/leader/admin gate as the SQL sandbox and bid management.
export async function addLedgerEntry(input: AddLedgerEntryInput): Promise<LedgerActionResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const perms = await getPermissions(session.user.id);
  if (!perms.can("epgp.ledger.manage")) {
    return { error: "Only officers, leaders, and admins can add ledger entries." };
  }

  const db = await getDb();
  const result = await insertLedgerEntry(db, input, session.user.id);
  return result.ok ? { standing: result.standing } : { error: result.error };
}

// Edits the activity/tier/item/points/date/note of an existing row —
// deliberately does NOT allow reassigning the character (that's a delete +
// re-add, not an edit, since it changes whose EP/GP total the row counts
// toward).
export async function updateLedgerEntry(input: UpdateLedgerEntryInput): Promise<LedgerActionResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const perms = await getPermissions(session.user.id);
  if (!perms.can("epgp.ledger.manage")) {
    return { error: "Only officers, leaders, and admins can edit ledger entries." };
  }

  if (!Number.isFinite(input.points)) return { error: "Points must be a number." };
  const occurredAt = parseOccurredAt(input.occurredAt);
  if (!occurredAt) return { error: "Invalid date." };
  const activityOrTier = (input.kind === "ep" ? input.activity : input.tier).trim();
  if (!activityOrTier) return { error: input.kind === "ep" ? "Activity is required." : "Bid is required." };
  const raidDate = input.kind === "ep" ? input.raidDate.trim() || null : null;
  if (raidDate && !guildDayBounds(raidDate)) return { error: "Event date must be a valid date." };
  if (raidDate && !ATTENDANCE_GATED_ACTIVITIES.has(activityOrTier)) {
    return { error: "Only attendance entries can be linked to a raid or event." };
  }

  const db = await getDb();
  // An edit never reassigns the character (that's a delete + re-add), so
  // the row's own player_id is the only standings that can move.
  let affectedPlayerId: number | null = null;
  let affectedCharacterId: number | null = null;
  if (input.kind === "ep") {
    const [before] = await db.select().from(epLedger).where(eq(epLedger.id, input.id));
    if (!before) return { error: "Ledger row not found." };
    affectedPlayerId = before.playerId;
    affectedCharacterId = before.characterId;
    if (affectedPlayerId != null) await markStandingsDirty(db, { playerIds: [affectedPlayerId] });
    const [after] = await db
      .update(epLedger)
      .set({
        activity: activityOrTier,
        points: input.points,
        pointsNominal: input.points,
        pointsAwarded: input.points,
        occurredAt,
        note: input.note.trim() || null,
        zone: input.zone.trim() || null,
        raidDate,
      })
      .where(eq(epLedger.id, input.id))
      .returning();
    await recordLedgerChange(db, "ep", input.id, "update", before, after, session.user.id);
  } else {
    const [before] = await db.select().from(gpLedger).where(eq(gpLedger.id, input.id));
    if (!before) return { error: "Ledger row not found." };
    affectedPlayerId = before.playerId;
    affectedCharacterId = before.characterId;
    if (affectedPlayerId != null) await markStandingsDirty(db, { playerIds: [affectedPlayerId] });
    const [after] = await db
      .update(gpLedger)
      .set({
        tier: activityOrTier,
        itemName: input.itemName.trim() || null,
        points: input.points,
        pointsNominal: input.points,
        pointsAwarded: input.points,
        occurredAt,
        note: input.note.trim() || null,
      })
      .where(eq(gpLedger.id, input.id))
      .returning();
    await recordLedgerChange(db, "gp", input.id, "update", before, after, session.user.id);
  }

  // Keep the materialized standings in step — every other EPGP-affecting
  // write path does this too (insertLedgerEntry, every decay commit). This
  // one and delete's below were the two that used to forget (then only
  // invalidating a cache; found auditing this file, 2026-08-25).
  // Best-effort (task 4.6) — the dirty marker written above the update
  // guarantees the repair pass finishes this even if settleStandings fails.
  let standing: StandingsRow | null = null;
  if (affectedPlayerId != null) {
    const settled = await settleStandings(db, { playerIds: [affectedPlayerId] });
    if (settled) standing = (await getStandingsForPlayers(db, [affectedPlayerId])).get(affectedPlayerId) ?? null;
  }
  // The edit may have moved this character's most recent ledger row (a
  // date change), which "bump if newer" can't walk back — recompute it.
  if (affectedCharacterId != null) await recomputeCharacterLastActivity(db, affectedCharacterId);

  return { standing };
}

export async function deleteLedgerEntry(kind: "ep" | "gp", id: number): Promise<LedgerActionResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const perms = await getPermissions(session.user.id);
  if (!perms.can("epgp.ledger.manage")) {
    return { error: "Only officers, leaders, and admins can delete ledger entries." };
  }

  const db = await getDb();
  let affectedPlayerId: number | null = null;
  let affectedCharacterId: number | null = null;
  if (kind === "ep") {
    const [before] = await db.select().from(epLedger).where(eq(epLedger.id, id));
    if (!before) return { error: "Ledger row not found." };
    affectedPlayerId = before.playerId;
    affectedCharacterId = before.characterId;
    if (affectedPlayerId != null) await markStandingsDirty(db, { playerIds: [affectedPlayerId] });
    await db.delete(epLedger).where(eq(epLedger.id, id));
    await recordLedgerChange(db, "ep", id, "delete", before, null, session.user.id);
  } else {
    const [before] = await db.select().from(gpLedger).where(eq(gpLedger.id, id));
    if (!before) return { error: "Ledger row not found." };
    affectedPlayerId = before.playerId;
    affectedCharacterId = before.characterId;
    if (affectedPlayerId != null) await markStandingsDirty(db, { playerIds: [affectedPlayerId] });
    await db.delete(gpLedger).where(eq(gpLedger.id, id));
    await recordLedgerChange(db, "gp", id, "delete", before, null, session.user.id);
  }

  let standing: StandingsRow | null = null;
  if (affectedPlayerId != null) {
    const settled = await settleStandings(db, { playerIds: [affectedPlayerId] });
    if (settled) standing = (await getStandingsForPlayers(db, [affectedPlayerId])).get(affectedPlayerId) ?? null;
  }
  // Deleting a row can drop this character's most recent activity — recompute.
  if (affectedCharacterId != null) await recomputeCharacterLastActivity(db, affectedCharacterId);

  return { standing };
}

// The audit trail's one editable field. `action`/`before`/`after` on a
// ledger_audit_log row are the immutable record of what changed; this note
// is the "why", added or corrected after the fact by an officer/leader/
// admin. Empty string clears it. See AuditLogTable / AuditNoteCell.
export async function setAuditNote(auditId: number, note: string): Promise<LedgerActionResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const perms = await getPermissions(session.user.id);
  if (!perms.can("epgp.ledger.manage")) {
    return { error: "Only officers, leaders, and admins can add audit notes." };
  }
  if (!Number.isInteger(auditId) || auditId <= 0) return { error: "Invalid audit entry." };

  const checked = boundedString(note, { max: 1000, field: "note" });
  if (!checked.ok) return { error: checked.error };
  const trimmed = checked.value;

  const db = await getDb();
  const [row] = await db.select({ id: ledgerAuditLog.id }).from(ledgerAuditLog).where(eq(ledgerAuditLog.id, auditId));
  if (!row) return { error: "Audit entry not found." };

  await db
    .update(ledgerAuditLog)
    .set({
      note: trimmed || null,
      noteUpdatedBy: session.user.id,
      noteUpdatedAt: new Date(),
    })
    .where(eq(ledgerAuditLog.id, auditId));

  return {};
}
