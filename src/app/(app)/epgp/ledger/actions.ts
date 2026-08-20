"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { epLedger, gpLedger } from "@/db";
import { canManageEpgp, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { insertLedgerEntry, type InsertLedgerEntryInput } from "@/lib/epgp/ledger-entry";
import { getSession } from "@/lib/session";

export type LedgerActionResult = { error?: string };

export type AddLedgerEntryInput = InsertLedgerEntryInput;

export type UpdateLedgerEntryInput =
  | { kind: "ep"; id: number; activity: string; points: number; occurredAt: string; note: string }
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
    await db
      .update(epLedger)
      .set({ activity: activityOrTier, points: input.points, occurredAt, note: input.note.trim() || null })
      .where(eq(epLedger.id, input.id));
  } else {
    await db
      .update(gpLedger)
      .set({ tier: activityOrTier, itemName: input.itemName.trim() || null, points: input.points, occurredAt, note: input.note.trim() || null })
      .where(eq(gpLedger.id, input.id));
  }

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
    await db.delete(epLedger).where(eq(epLedger.id, id));
  } else {
    await db.delete(gpLedger).where(eq(gpLedger.id, id));
  }

  return {};
}
