import { and, eq, lt, or, isNull } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { characters, epLedger, gpLedger } from "@/db";
import { recordLedgerChange } from "@/lib/epgp/ledger-audit";
import { getSettingAt } from "@/lib/epgp/settings";
import { refreshStandings } from "@/lib/epgp/standings";
import { boundedNumber, boundedString, isoDate, LIMITS, optionalText } from "@/lib/validate";

// Shared by the website's manual-entry Server Action
// (src/app/(app)/epgp/ledger/actions.ts) and the officer app's
// POST /api/officer/manual-entry route — one place that decides what makes
// a valid ep_ledger/gp_ledger row, so the two calling conventions
// (redirect-on-no-session vs. JSON error response) can't drift into
// different validation rules. Callers are responsible for their own
// auth/permission check before calling this — it only validates the row
// shape and inserts.
//
// A `source: "manual"` insert also writes a `create` ledger_audit_log row
// (parity with updateLedgerEntry/deleteLedgerEntry, which have always been
// audited). `source: "parse"` — bulk attendance awards and per-bid GP
// charges — is not audited: those land dozens at a time and already trace
// back through loot_events/bids and the capture itself.
export type LedgerEntrySource = "manual" | "parse";

export type InsertLedgerEntryInput =
  | { kind: "ep"; characterId: number; activity: string; points: number; occurredAt: string; note: string; zone?: string | null }
  | { kind: "gp"; characterId: number; tier: string; itemName: string; points: number; occurredAt: string; note: string };

// `playerId` is the account this row landed on (an alt's row is redirected
// to its main's character but keeps the shared player_id) — returned so a
// bulk caller that passed `deferStandingsRefresh` can collect every
// affected player and do one `refreshStandings({ playerIds })` at the end
// instead of one per row. NULL only for a character with no player_id yet.
export type InsertLedgerEntryResult = { ok: true; playerId: number | null } | { ok: false; error: string };

export async function insertLedgerEntry(
  db: ReturnType<typeof drizzle>,
  input: InsertLedgerEntryInput,
  enteredBy: string,
  source: LedgerEntrySource = "manual",
  opts: { deferStandingsRefresh?: boolean } = {},
): Promise<InsertLedgerEntryResult> {
  // Range sanity on the values that reach D1 — every write path (site form,
  // officer manual-entry / attendance / bids routes) funnels through here,
  // so a non-finite or absurd points value, an epoch-0 date, or an
  // unbounded activity/tier string is rejected in one place. See
  // src/lib/validate.ts.
  const pointsCheck = boundedNumber(input.points, { field: "points" });
  if (!pointsCheck.ok) return { ok: false, error: pointsCheck.error };
  const dateCheck = isoDate(input.occurredAt, "occurredAt");
  if (!dateCheck.ok) return { ok: false, error: dateCheck.error };
  const occurredAt = dateCheck.value;
  const activityCheck = boundedString(input.kind === "ep" ? input.activity : input.tier, {
    max: LIMITS.activity,
    min: 1,
    field: input.kind === "ep" ? "activity" : "tier",
  });
  if (!activityCheck.ok) {
    return { ok: false, error: input.kind === "ep" ? "Activity is required." : "Bid is required." };
  }
  const activityOrTier = activityCheck.value;
  const noteCheck = optionalText(input.note, LIMITS.note, "note");
  if (!noteCheck.ok) return { ok: false, error: noteCheck.error };
  if (input.kind === "gp") {
    const itemCheck = optionalText(input.itemName, LIMITS.itemName, "itemName");
    if (!itemCheck.ok) return { ok: false, error: itemCheck.error };
  }
  if (input.kind === "ep") {
    const zoneCheck = optionalText(input.zone, LIMITS.zone, "zone");
    if (!zoneCheck.ok) return { ok: false, error: zoneCheck.error };
  }

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
    const [row] = await db
      .insert(epLedger)
      .values({
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
      })
      .returning();
    if (source === "manual") await recordLedgerChange(db, "ep", row.id, "create", null, row, enteredBy);
  } else {
    const [row] = await db
      .insert(gpLedger)
      .values({
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
      })
      .returning();
    if (source === "manual") await recordLedgerChange(db, "gp", row.id, "create", null, row, enteredBy);
  }

  // Keep characters.last_activity_at current for the roster/dashboard/
  // progression "recently active" filters — bump the character the row was
  // written against (targetCharacterId — an alt's award lands on its main,
  // matching how the old GROUP BY grouped) if this award is newer. Only
  // moves forward; a ledger edit/delete that could move it back calls
  // recomputeCharacterLastActivity instead. Never a decay row here
  // (decay.ts writes those directly, not through this function).
  await db
    .update(characters)
    .set({ lastActivityAt: occurredAt })
    .where(
      and(
        eq(characters.id, targetCharacterId),
        or(isNull(characters.lastActivityAt), lt(characters.lastActivityAt, occurredAt)),
      ),
    );

  // Every EPGP-affecting write goes through this function (website form,
  // officer manual-entry/attendance/bids routes), so refreshing the
  // player's materialized standings row here covers every single-row
  // caller. Bulk callers (attendance, a bid round's GP charges) pass
  // `deferStandingsRefresh` and do one `refreshStandings({ playerIds })`
  // for the whole batch instead — see those routes.
  if (!opts.deferStandingsRefresh && playerId != null) {
    await refreshStandings(db, { playerIds: [playerId] });
  }

  return { ok: true, playerId };
}
