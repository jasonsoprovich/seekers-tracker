import { and, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { cycles, epLedger } from "@/db";
import { getSettingAt } from "@/lib/epgp/settings";
import { guildDayBounds, toGuildDateString } from "@/lib/guild-timezone";

type Db = ReturnType<typeof drizzle>;
type Cycle = typeof cycles.$inferSelect;

// Write-time enforcement of the per-cycle EP cap (`ep_cap_per_cycle`, 900
// today). Every new positive EP award — attendance, Event Lead, manual entry
// — is clamped to whatever room the player has left in the cycle the row
// falls in. A player already at the cap still gets a row (attendance is
// recorded) with 0 EP and a note saying why; a partial fit records only the
// remainder. Nominal vs. awarded is kept on the row (points_nominal /
// points_awarded / cap_applied), matching what the sheet import writes.
//
// Never recomputed against history (PLAN.md §2: 189 historical pairs exceed
// the cap and stay as recorded), and never applied to negative rows.
//
// What counts toward "used": the player's net non-decay EP in the cycle.
// Decay/departure rows (decay_event_id set) are administrative, not earned.
// A negative correction row lowers cycle EP, so an officer who backs an
// award out frees that room up again.
export type EpCapInput = {
  playerId: number | null;
  nominal: number;
  occurredAt: Date;
  // Editing an existing row: leave that row's own points out of "used", so
  // re-saving a row never counts it against itself.
  excludeRowId?: number;
};
export type EpCapOutcome = {
  awarded: number;
  capApplied: boolean;
  cap: number | null;
  cycleId: number | null;
  // Text to append to the row's note when capped; null when not.
  note: string | null;
};

const IN_CHUNK = 90;
const FAR_FUTURE = new Date(8.64e15);

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Ledger dates are of two kinds: sheet/manual-form rows sit at exactly UTC
// midnight of their date (a bucket), while officer-app rows carry the real
// timestamp. A real Eastern-evening timestamp is already "tomorrow" in UTC,
// so bucket rows read their UTC date and everything else reads the guild-
// local date — the same convention ledgerDate() uses for display.
function effectiveDay(t: Date): string {
  return t.getTime() % 86_400_000 === 0 ? utcDay(t) : toGuildDateString(t);
}

type CycleWindow = { cycle: Cycle; etStart: Date; etEnd: Date; utcStart: Date; utcEnd: Date };

function windowFor(all: Cycle[], t: Date): CycleWindow | null {
  const day = effectiveDay(t);
  let cycle = all.find((c) => utcDay(c.startDate) <= day && day <= utcDay(c.endDate));
  let openEnded = false;
  if (!cycle) {
    // A calendar gap (a cycle not added yet): the latest started cycle stays
    // "current", same fallback getCurrentCycle uses.
    cycle = all.filter((c) => utcDay(c.startDate) <= day).at(-1);
    openEnded = true;
  }
  if (!cycle) return null;
  const startBounds = guildDayBounds(utcDay(cycle.startDate));
  const endBounds = guildDayBounds(utcDay(cycle.endDate));
  return {
    cycle,
    etStart: startBounds?.start ?? cycle.startDate,
    etEnd: openEnded ? FAR_FUTURE : (endBounds?.end ?? cycle.endDate),
    utcStart: cycle.startDate,
    utcEnd: openEnded ? FAR_FUTURE : cycle.endDate,
  };
}

// Net non-decay EP each player already has in one cycle window. Real
// timestamps are matched against the guild-local day range; UTC-midnight
// bucket rows against the cycle's own UTC dates (so a manual/sheet entry on
// the first or last day counts, without pulling in the previous evening's
// real raid).
async function cycleEpUsed(db: Db, playerIds: number[], w: CycleWindow, excludeRowId?: number): Promise<Map<number, number>> {
  const used = new Map<number, number>();
  for (let i = 0; i < playerIds.length; i += IN_CHUNK) {
    const rows = await db
      .select({ playerId: epLedger.playerId, sum: sql<number>`coalesce(sum(${epLedger.points}), 0)` })
      .from(epLedger)
      .where(
        and(
          inArray(epLedger.playerId, playerIds.slice(i, i + IN_CHUNK)),
          isNull(epLedger.decayEventId),
          excludeRowId !== undefined ? ne(epLedger.id, excludeRowId) : undefined,
          or(
            and(gte(epLedger.occurredAt, w.etStart), lt(epLedger.occurredAt, w.etEnd)),
            and(gte(epLedger.occurredAt, w.utcStart), lte(epLedger.occurredAt, w.utcEnd), sql`${epLedger.occurredAt} % 86400 = 0`),
          ),
        ),
      )
      .groupBy(epLedger.playerId);
    for (const r of rows) if (r.playerId !== null) used.set(r.playerId, Number(r.sum));
  }
  return used;
}

export function applyEpCap(nominal: number, used: number, cap: number | null): { awarded: number; capApplied: boolean } {
  if (cap === null || !Number.isFinite(cap) || cap <= 0 || nominal <= 0) return { awarded: nominal, capApplied: false };
  const room = Math.max(0, cap - used);
  const awarded = Math.min(nominal, room);
  return { awarded, capApplied: awarded < nominal };
}

function capNote(cap: number, nominal: number, awarded: number): string {
  return awarded <= 0
    ? `EP capped: already at the ${cap} EP cycle cap (0 of ${nominal} EP awarded)`
    : `EP capped at the ${cap} EP cycle cap (${awarded} of ${nominal} EP awarded)`;
}

// Resolves the cap for a whole batch in a fixed number of round trips:
// cycles once, the cap setting once per distinct timestamp, and one SUM per
// (cycle, ≤90 players). Rows are processed in order and each award counts
// against the next row for the same player, so a batch can't overshoot the
// cap by carrying two rows for one player.
export async function resolveEpCaps(db: Db, inputs: EpCapInput[]): Promise<EpCapOutcome[]> {
  const passthrough = (i: EpCapInput, cap: number | null, cycleId: number | null): EpCapOutcome => ({
    awarded: i.nominal,
    capApplied: false,
    cap,
    cycleId,
    note: null,
  });
  if (inputs.length === 0) return [];

  const allCycles = await db.select().from(cycles);
  allCycles.sort((a, b) => a.startDate.getTime() - b.startDate.getTime());

  const capByTime = new Map<number, number | null>();
  const windowByTime = new Map<number, CycleWindow | null>();
  for (const i of inputs) {
    const t = i.occurredAt.getTime();
    if (capByTime.has(t)) continue;
    const raw = await getSettingAt(db, "ep_cap_per_cycle", i.occurredAt);
    capByTime.set(t, raw !== null ? Number(raw) : null);
    windowByTime.set(t, windowFor(allCycles, i.occurredAt));
  }

  // Only rows that can actually be capped need a lookup.
  const playersByCycle = new Map<number, { window: CycleWindow; ids: Set<number> }>();
  for (const i of inputs) {
    const w = windowByTime.get(i.occurredAt.getTime());
    const cap = capByTime.get(i.occurredAt.getTime()) ?? null;
    if (!w || cap === null || i.nominal <= 0 || i.playerId === null) continue;
    const entry = playersByCycle.get(w.cycle.id) ?? { window: w, ids: new Set<number>() };
    entry.ids.add(i.playerId);
    playersByCycle.set(w.cycle.id, entry);
  }
  // excludeRowId only comes from the single-row edit path, so one id per
  // batch is enough.
  const excludeRowId = inputs.find((i) => i.excludeRowId !== undefined)?.excludeRowId;
  const usedByCycle = new Map<number, Map<number, number>>();
  for (const [cycleId, { window, ids }] of playersByCycle) {
    usedByCycle.set(cycleId, await cycleEpUsed(db, [...ids], window, excludeRowId));
  }

  return inputs.map((i) => {
    const t = i.occurredAt.getTime();
    const w = windowByTime.get(t) ?? null;
    const cap = capByTime.get(t) ?? null;
    const cycleId = w?.cycle.id ?? null;
    if (!w || cap === null || i.nominal <= 0 || i.playerId === null) return passthrough(i, cap, cycleId);
    const used = usedByCycle.get(w.cycle.id)!;
    const before = used.get(i.playerId) ?? 0;
    const { awarded, capApplied } = applyEpCap(i.nominal, before, cap);
    used.set(i.playerId, before + awarded);
    return { awarded, capApplied, cap, cycleId, note: capApplied ? capNote(cap, i.nominal, awarded) : null };
  });
}

export type CycleEpProgress = {
  cycle: Cycle;
  cap: number | null;
  // Net non-decay EP per player in the cycle: the same number the write
  // path clamps against, so the display can never disagree with enforcement.
  usedByPlayer: Map<number, number>;
};

// The current cycle's EP-vs-cap for a set of players, for display. Reuses
// the exact window and sum resolveEpCaps uses. Returns null when no cycle
// has started (no cap is applied then either).
export async function getCurrentCycleEp(db: Db, playerIds: number[], asOf: Date = new Date()): Promise<CycleEpProgress | null> {
  const allCycles = await db.select().from(cycles);
  allCycles.sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
  const w = windowFor(allCycles, asOf);
  if (!w) return null;
  const raw = await getSettingAt(db, "ep_cap_per_cycle", asOf);
  const cap = raw !== null && Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : null;
  const usedByPlayer = playerIds.length > 0 ? await cycleEpUsed(db, playerIds, w) : new Map<number, number>();
  return { cycle: w.cycle, cap, usedByPlayer };
}

const CAP_NOTE_RE = /(?:\s+—\s+)?EP capped(?::| at) [^—]*$/;

// Removes a previously appended cap note, so an edit that re-applies the
// cap doesn't stack "— EP capped …" twice.
export function stripCapNote(note: string | null | undefined): string {
  return (note ?? "").replace(CAP_NOTE_RE, "").trim();
}

type EpRow = typeof epLedger.$inferSelect;
export type EpEditPoints = {
  fields: Partial<typeof epLedger.$inferInsert>;
  note: string | null;
  capped?: { awarded: number; nominal: number };
};

// The point/cap columns for an officer's edit of an existing EP row. The cap
// applies to edits too, but only when the points or date actually change: a
// note/zone-only edit keeps the recorded award as-is (including a bypassCap
// entry). The edit form shows the awarded figure, so a date move with the
// points field untouched keeps the original nominal amount. Decay rows are
// administrative and never clamped.
export async function resolveEpEditPoints(
  db: Db,
  before: EpRow,
  input: { points: number; occurredAt: Date; dateChanged: boolean; note: string },
): Promise<EpEditPoints> {
  const pointsChanged = input.points !== before.points;
  const typedNote = input.note.trim() || null;
  if (before.decayEventId != null || (!pointsChanged && !input.dateChanged)) {
    return {
      fields: pointsChanged ? { points: input.points, pointsNominal: input.points, pointsAwarded: input.points } : {},
      note: typedNote,
    };
  }
  const nominal = pointsChanged ? input.points : (before.pointsNominal ?? before.points);
  const [cap] = await resolveEpCaps(db, [{ playerId: before.playerId, nominal, occurredAt: input.occurredAt, excludeRowId: before.id }]);
  return {
    fields: {
      points: cap.awarded,
      pointsNominal: nominal,
      pointsAwarded: cap.awarded,
      capApplied: cap.capApplied,
      capAtEntry: cap.cap,
      cycleId: cap.cycleId,
    },
    note: withCapNote(stripCapNote(input.note), cap.note),
    capped: cap.capApplied ? { awarded: cap.awarded, nominal } : undefined,
  };
}

// "existing note — cap note", tolerating either being empty.
export function withCapNote(note: string | null | undefined, capNoteText: string | null): string | null {
  const base = note?.trim() || "";
  if (!capNoteText) return base || null;
  return base ? `${base} — ${capNoteText}` : capNoteText;
}
