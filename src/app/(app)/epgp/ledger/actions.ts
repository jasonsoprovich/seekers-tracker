"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { epLedger, gpLedger } from "@/db";
import { canManageEpgp, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { recordLedgerChange } from "@/lib/epgp/ledger-audit";
import { insertLedgerEntry, type InsertLedgerEntryInput } from "@/lib/epgp/ledger-entry";
import { invalidateEpgpTotalsCache } from "@/lib/epgp/totals";
import { getSession } from "@/lib/session";

export type LedgerActionResult = { error?: string };

export type AddLedgerEntryInput = InsertLedgerEntryInput;

export type UpdateLedgerEntryInput =
  | { kind: "ep"; id: number; activity: string; points: number; occurredAt: string; note: string; zone: string }
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

  const role = await getUserRole(session.user.id);
  if (!canManageEpgp(role)) {
    return { error: "Only officers, leaders, and admins can add ledger entries." };
  }

  const db = await getDb();
  const result = await insertLedgerEntry(db, input, session.user.id);
  return result.ok ? {} : { error: result.error };
}

// Edits the activity/tier/item/points/date/note of an existing row —
// deliberately does NOT allow reassigning the character (that's a delete +
// re-add, not an edit, since it changes whose EP/GP total the row counts
// toward).
export async function updateLedgerEntry(input: UpdateLedgerEntryInput): Promise<LedgerActionResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);
  if (!canManageEpgp(role)) {
    return { error: "Only officers, leaders, and admins can edit ledger entries." };
  }

  if (!Number.isFinite(input.points)) return { error: "Points must be a number." };
  const occurredAt = parseOccurredAt(input.occurredAt);
  if (!occurredAt) return { error: "Invalid date." };
  const activityOrTier = (input.kind === "ep" ? input.activity : input.tier).trim();
  if (!activityOrTier) return { error: input.kind === "ep" ? "Activity is required." : "Tier is required." };

  const db = await getDb();
  if (input.kind === "ep") {
    const [before] = await db.select().from(epLedger).where(eq(epLedger.id, input.id));
    if (!before) return { error: "Ledger row not found." };
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
      })
      .where(eq(epLedger.id, input.id))
      .returning();
    await recordLedgerChange(db, "ep", input.id, "update", before, after, session.user.id);
  } else {
    const [before] = await db.select().from(gpLedger).where(eq(gpLedger.id, input.id));
    if (!before) return { error: "Ledger row not found." };
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

  // Every other EPGP-affecting write path invalidates this cache
  // (insertLedgerEntry, every decay commit) — this one and delete's below
  // didn't, which left /roster showing stale EP/GP after an officer edited
  // or deleted a row. Found auditing this file, 2026-08-25.
  await invalidateEpgpTotalsCache();

  return {};
}

export async function deleteLedgerEntry(kind: "ep" | "gp", id: number): Promise<LedgerActionResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);
  if (!canManageEpgp(role)) {
    return { error: "Only officers, leaders, and admins can delete ledger entries." };
  }

  const db = await getDb();
  if (kind === "ep") {
    const [before] = await db.select().from(epLedger).where(eq(epLedger.id, id));
    if (!before) return { error: "Ledger row not found." };
    await db.delete(epLedger).where(eq(epLedger.id, id));
    await recordLedgerChange(db, "ep", id, "delete", before, null, session.user.id);
  } else {
    const [before] = await db.select().from(gpLedger).where(eq(gpLedger.id, id));
    if (!before) return { error: "Ledger row not found." };
    await db.delete(gpLedger).where(eq(gpLedger.id, id));
    await recordLedgerChange(db, "gp", id, "delete", before, null, session.user.id);
  }

  await invalidateEpgpTotalsCache();

  return {};
}
