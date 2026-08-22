import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { characters, decayEvents, epLedger, gpLedger } from "@/db";
import { recordLedgerChange } from "@/lib/epgp/ledger-audit";
import { invalidateEpgpTotalsCache } from "@/lib/epgp/totals";

// PLAN.md §1b — one entry point per decay mechanism that writes stored
// rows. Legacy cycle decay (§1a) stays derived at read time in
// totals.ts and never appears here. global_cycle (§1c, Phase 5) and
// departure (§1e, Phase 3) reuse the same decay_events table and the same
// preview -> commit -> reverse shape this file builds for expansion decay,
// but aren't implemented yet.
export const DECAY_KINDS = ["legacy_cycle", "global_cycle", "expansion", "departure"] as const;
export type DecayKind = (typeof DECAY_KINDS)[number];

export type DecayPreviewRow = {
  characterId: number;
  characterName: string;
  epBalance: number;
  epDecay: number;
  gpBalance: number;
  gpDecay: number;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Sum of every ep_ledger/gp_ledger row strictly before `effectiveDate`,
// grouped by character — the "then-current net balance" §1b decays against.
// This is the raw ledger sum, not computeEpgpTotals' derived legacy-1a
// figure: 1a is a display-time-only subtraction that never touches what's
// actually owed, and expansion decay has always been applied to the real
// balance (confirmed against the historical 2025-12-30 event — e.g.
// Aazimoku's stored rows summed to exactly 150.0 before that decay, and
// 150 * 0.85 = 127.5, matching the historical row to the cent).
async function balancesAt(
  db: ReturnType<typeof drizzle>,
  ledger: typeof epLedger | typeof gpLedger,
  effectiveDate: Date,
): Promise<Map<number, number>> {
  const rows = await db
    .select({ characterId: ledger.characterId, sum: sql<number>`coalesce(sum(${ledger.points}), 0)` })
    .from(ledger)
    .where(lt(ledger.occurredAt, effectiveDate))
    .groupBy(ledger.characterId);
  return new Map(rows.map((r) => [r.characterId, r.sum]));
}

// Every character with a positive EP or GP balance as of `effectiveDate`,
// and the exact amount `rate` would take from each. Read-only — safe to
// call as often as the leader wants before committing. A character whose
// balance is already <= 0 is left out entirely (mirrors the sheet: a
// character owed nothing never got a Decay row).
export async function previewExpansionDecay(db: ReturnType<typeof drizzle>, rate: number, effectiveDate: Date): Promise<DecayPreviewRow[]> {
  const [epBalances, gpBalances, allCharacters] = await Promise.all([
    balancesAt(db, epLedger, effectiveDate),
    balancesAt(db, gpLedger, effectiveDate),
    db.select({ id: characters.id, name: characters.name }).from(characters),
  ]);
  const names = new Map(allCharacters.map((c) => [c.id, c.name]));
  const characterIds = new Set([...epBalances.keys(), ...gpBalances.keys()]);

  const rows: DecayPreviewRow[] = [];
  for (const characterId of characterIds) {
    const epBalance = epBalances.get(characterId) ?? 0;
    const gpBalance = gpBalances.get(characterId) ?? 0;
    if (epBalance <= 0 && gpBalance <= 0) continue;
    rows.push({
      characterId,
      characterName: names.get(characterId) ?? `#${characterId}`,
      epBalance,
      epDecay: epBalance > 0 ? round2(epBalance * rate) : 0,
      gpBalance,
      gpDecay: gpBalance > 0 ? round2(gpBalance * rate) : 0,
    });
  }
  rows.sort((a, b) => a.characterName.localeCompare(b.characterName));
  return rows;
}

// Guards against double-applying the same event (PLAN.md §2.5) — a
// reversed event doesn't block a redo on the same date.
export async function findActiveExpansionDecayEvent(db: ReturnType<typeof drizzle>, effectiveDate: Date) {
  const [row] = await db
    .select()
    .from(decayEvents)
    .where(and(eq(decayEvents.kind, "expansion"), eq(decayEvents.effectiveDate, effectiveDate), isNull(decayEvents.reversedAt)));
  return row ?? null;
}

export type CommitDecayResult = { decayEventId: number; epRows: number; gpRows: number };
export type CommitDecayOutcome = CommitDecayResult | { error: string };

// Writes one decay_events row plus every non-zero preview row as a linked
// negative ep_ledger/gp_ledger entry, activity/tier "Decay" — same label
// the sheet import used for the 3 historical events (scripts/import-epgp.ts),
// so this reads identically to them in the ledger view. Not a single D1
// transaction (this codebase's other multi-row writes — bids, attendance —
// follow the same parent-row-first, sequential-insert shape; see
// bids/route.ts), but the decay_events row is meaningless with zero linked
// rows, so a failure partway through still leaves something reversible
// rather than silently-wrong totals.
export async function commitExpansionDecay(
  db: ReturnType<typeof drizzle>,
  opts: { rate: number; effectiveDate: Date; label?: string; appliedBy: string },
): Promise<CommitDecayOutcome> {
  const { rate, effectiveDate, appliedBy } = opts;
  const label = opts.label?.trim() || null;

  const existing = await findActiveExpansionDecayEvent(db, effectiveDate);
  if (existing) {
    return { error: `An expansion decay event already exists for ${effectiveDate.toDateString()} — reverse it first to redo.` };
  }

  const preview = await previewExpansionDecay(db, rate, effectiveDate);
  if (preview.length === 0) {
    return { error: "No characters have a positive EP or GP balance to decay as of that date." };
  }

  const [event] = await db
    .insert(decayEvents)
    .values({ kind: "expansion", epRate: rate, gpRate: rate, effectiveDate, label, appliedBy })
    .returning();

  let epRows = 0;
  let gpRows = 0;
  for (const row of preview) {
    if (row.epDecay > 0) {
      await db.insert(epLedger).values({
        characterId: row.characterId,
        occurredAt: effectiveDate,
        activity: "Decay",
        points: -row.epDecay,
        note: label,
        enteredBy: appliedBy,
        source: "manual",
        decayEventId: event.id,
      });
      epRows++;
    }
    if (row.gpDecay > 0) {
      await db.insert(gpLedger).values({
        characterId: row.characterId,
        occurredAt: effectiveDate,
        tier: "Decay",
        points: -row.gpDecay,
        note: label,
        enteredBy: appliedBy,
        source: "manual",
        decayEventId: event.id,
      });
      gpRows++;
    }
  }

  await invalidateEpgpTotalsCache();
  return { decayEventId: event.id, epRows, gpRows };
}

export type ReverseDecayOutcome = { ok: true; epRows: number; gpRows: number } | { error: string };

// Deletes every ep_ledger/gp_ledger row the event produced (PLAN.md §2.6)
// and marks the event reversed rather than deleting it — the event row is
// the record that a decay happened and was later undone. Each deleted
// ledger row still gets a ledger_audit_log entry (recordLedgerChange,
// action "delete") for the same reason every other ledger delete does: the
// audit trail has no FK to the row it describes, so it survives the delete.
export async function reverseDecayEvent(db: ReturnType<typeof drizzle>, decayEventId: number, reversedBy: string): Promise<ReverseDecayOutcome> {
  const [event] = await db.select().from(decayEvents).where(eq(decayEvents.id, decayEventId));
  if (!event) return { error: "Decay event not found." };
  if (event.reversedAt) return { error: "This decay event was already reversed." };

  const [epRowsBefore, gpRowsBefore] = await Promise.all([
    db.select().from(epLedger).where(eq(epLedger.decayEventId, decayEventId)),
    db.select().from(gpLedger).where(eq(gpLedger.decayEventId, decayEventId)),
  ]);

  for (const row of epRowsBefore) {
    await db.delete(epLedger).where(eq(epLedger.id, row.id));
    await recordLedgerChange(db, "ep", row.id, "delete", row, null, reversedBy);
  }
  for (const row of gpRowsBefore) {
    await db.delete(gpLedger).where(eq(gpLedger.id, row.id));
    await recordLedgerChange(db, "gp", row.id, "delete", row, null, reversedBy);
  }

  await db.update(decayEvents).set({ reversedAt: new Date(), reversedBy }).where(eq(decayEvents.id, decayEventId));
  await invalidateEpgpTotalsCache();

  return { ok: true, epRows: epRowsBefore.length, gpRows: gpRowsBefore.length };
}
