import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { characters, epLedger, gpLedger } from "@/db";

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
  | { kind: "ep"; characterId: number; activity: string; points: number; occurredAt: string; note: string }
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

  const [character] = await db.select({ id: characters.id }).from(characters).where(eq(characters.id, input.characterId));
  if (!character) return { ok: false, error: "Character not found." };

  if (input.kind === "ep") {
    await db.insert(epLedger).values({
      characterId: input.characterId,
      occurredAt,
      activity: activityOrTier,
      points: input.points,
      note: input.note.trim() || null,
      enteredBy,
      source,
    });
  } else {
    await db.insert(gpLedger).values({
      characterId: input.characterId,
      occurredAt,
      itemName: input.itemName.trim() || null,
      tier: activityOrTier,
      points: input.points,
      note: input.note.trim() || null,
      enteredBy,
      source,
    });
  }

  return { ok: true };
}
