import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { characters, decayEvents, epLedger, gpLedger, players } from "@/db";
import { prepareDeleteAudit } from "@/lib/epgp/ledger-audit";
import { markStandingsDirty, settleStandings } from "@/lib/epgp/standings";
import { ledgerDate } from "@/lib/format-date";
import { guildDayBounds, toGuildDateString } from "@/lib/guild-timezone";
import { recordSystemEvent, webActor } from "@/lib/system-log";

// PLAN.md §1b/§1c — one entry point per decay mechanism that writes stored
// rows. Legacy cycle decay (§1a) stays derived at read time in totals.ts
// and never appears here. expansion (§1b/Phase 2) and global_cycle
// (§1c/Phase 5) share the exact same mechanics — rate x whatever balance a
// character had before effectiveDate, written as a linked negative ledger
// row — so previewRateDecay/commitRateDecay/findActiveRateDecayEvent below
// take a kind and serve both; only the label and the decay_events.kind
// differ. departure is its own shape (a full wipe, not a rate) — see
// previewDepartureWipe below.
export const DECAY_KINDS = ["legacy_cycle", "global_cycle", "expansion", "departure"] as const;
export type DecayKind = (typeof DECAY_KINDS)[number];
export type RateDecayKind = Extract<DecayKind, "expansion" | "global_cycle">;

export type DecayPreviewRow = {
  characterId: number;
  characterName: string;
  // Carried through to commit so the negative ledger row it writes can set
  // player_id directly (§11 Phase 3 task 3.11 grouped computeEpgpTotals by
  // player_id; a row with player_id NULL is invisible to it — same as an
  // orphaned row). Null only for a character that itself has no player_id
  // yet, same edge case totals.ts already excludes safely (PLAN.md §16).
  playerId: number | null;
  epBalance: number;
  epDecay: number;
  gpBalance: number;
  gpDecay: number;
};

export type DecayCutoffResult = { effectiveDate: Date; cutoff: Date } | { error: string };

// Turns the leader's picked "as of" date into two instants:
//   - effectiveDate: the label date stored on the decay event and its ledger
//     rows — UTC midnight of the picked day, exactly as before, so the ledger
//     shows the date that was picked and the duplicate-date guard is
//     unchanged;
//   - cutoff: the exclusive instant balancesAt sums up to.
// The cutoff used to *be* effectiveDate, and a bare YYYY-MM-DD through
// `new Date()` is UTC midnight — 8pm Eastern the evening before — so picking
// *today* silently dropped every entry from today (and anything after 8pm ET
// yesterday). Now the cutoff is resolved in the guild's timezone:
//   - today  -> right now, so a decay "as of today" sees everything recorded
//     so far (a raid entered later tonight simply belongs to the next decay);
//   - a past day -> the end of that Eastern day, i.e. through that whole day;
//   - a future day -> rejected (nothing to decay against yet).
// A full ISO timestamp (an API caller passing an exact instant) is used for
// both, so existing callers don't change behavior.
export function resolveDecayCutoff(raw: string, now: Date = new Date()): DecayCutoffResult {
  if (!raw) return { error: "Pick a valid effective date." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? { error: "Pick a valid effective date." } : { effectiveDate: d, cutoff: d };
  }
  const bounds = guildDayBounds(raw);
  const effectiveDate = new Date(raw);
  if (!bounds || Number.isNaN(effectiveDate.getTime())) return { error: "Pick a valid effective date." };
  const today = toGuildDateString(now);
  if (raw > today) return { error: `${raw} is in the future — pick today (${today}) or an earlier date.` };
  return { effectiveDate, cutoff: raw === today ? now : bounds.end };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// One decay "unit" = one account's net balance. computeEpgpTotals groups by
// the ledger's player_id, so what a member actually holds is the SUM across
// every character on the account — and decay has to be taken against that
// same figure. Taking it per character (the original behavior) breaks after
// a main/alt swap: the earned EP gets re-attributed to the new main while the
// old main keeps only its earlier (negative) decay rows. Decaying the new
// main's positive balance and skipping the old main's negative one leaves
// `rate*X - Y` instead of `rate*(X - Y)` — found after the 2026-09-29
// expansion decay left Korrek/Blesko/Youmadin/Tunedup near zero or negative.
// A ledger row with no player_id (legacy/unlinked) stays its own per-character
// unit, as before.
type BalanceUnit = { playerId: number | null; byCharacter: Map<number, number>; net: number };

function unitKey(playerId: number | null, characterId: number): string {
  return playerId !== null ? `p${playerId}` : `c${characterId}`;
}

// Sum of every ep_ledger/gp_ledger row strictly before `cutoff` (or all rows
// when `cutoff` is omitted — the departure wipe zeroes *current* EP), per
// account — the "then-current net balance" §1b decays against.
// This is the raw ledger sum, not computeEpgpTotals' derived legacy-1a
// figure: 1a is a display-time-only subtraction that never touches what's
// actually owed, and expansion decay has always been applied to the real
// balance (confirmed against the historical 2025-12-30 event — e.g.
// Aazimoku's stored rows summed to exactly 150.0 before that decay, and
// 150 * 0.85 = 127.5, matching the historical row to the cent).
async function unitBalances(
  db: ReturnType<typeof drizzle>,
  ledger: typeof epLedger | typeof gpLedger,
  cutoff?: Date,
): Promise<Map<string, BalanceUnit>> {
  const rows = await db
    .select({ characterId: ledger.characterId, playerId: ledger.playerId, sum: sql<number>`coalesce(sum(${ledger.points}), 0)` })
    .from(ledger)
    .where(cutoff ? lt(ledger.occurredAt, cutoff) : undefined)
    .groupBy(ledger.characterId, ledger.playerId);
  const units = new Map<string, BalanceUnit>();
  for (const r of rows) {
    // An orphaned row (§1e/§4d) has a NULL character_id and belongs to no
    // one — excluded here rather than decayed against a phantom "null"
    // character.
    if (r.characterId === null) continue;
    const key = unitKey(r.playerId, r.characterId);
    const unit = units.get(key) ?? { playerId: r.playerId, byCharacter: new Map<number, number>(), net: 0 };
    unit.byCharacter.set(r.characterId, (unit.byCharacter.get(r.characterId) ?? 0) + r.sum);
    unit.net += r.sum;
    units.set(key, unit);
  }
  return units;
}

// Which character a unit's decay/wipe row is written on: the account's main
// when it has one, else the character carrying the most balance (ties and the
// no-balance case fall to the first). Display only — standings are by player.
function pickTargetCharacter(
  playerId: number | null,
  mainByPlayer: Map<number, number | null>,
  ...units: (BalanceUnit | undefined)[]
): number {
  const main = playerId !== null ? mainByPlayer.get(playerId) ?? null : null;
  const candidates = new Map<number, number>();
  for (const unit of units) {
    if (!unit) continue;
    for (const [characterId, sum] of unit.byCharacter) candidates.set(characterId, (candidates.get(characterId) ?? 0) + sum);
  }
  if (main !== null) return main;
  let best = -1;
  let bestSum = -Infinity;
  for (const [characterId, sum] of candidates) {
    if (sum > bestSum) {
      best = characterId;
      bestSum = sum;
    }
  }
  return best;
}

// Last EP-earning activity per character — a "Decay"/"Departure" row is
// administrative, not raiding, so it must not count as recent activity or
// a just-wiped character would look "active" again. Used by
// previewDepartureWipe's inactiveSince filter (§1f: "removing any EP from
// players who haven't raided since the start of Velious").
async function lastPositiveEpActivity(db: ReturnType<typeof drizzle>): Promise<Map<number, Date>> {
  const rows = await db
    .select({ characterId: epLedger.characterId, last: sql<number>`max(${epLedger.occurredAt})` })
    .from(epLedger)
    .where(gt(epLedger.points, 0))
    .groupBy(epLedger.characterId);
  return new Map(rows.filter((r) => r.characterId !== null).map((r) => [r.characterId as number, new Date(Number(r.last) * 1000)]));
}

// Every character with a positive EP or GP balance as of `effectiveDate`,
// and the exact amount `rate` would take from each. Read-only — safe to
// call as often as the leader wants before committing. A character whose
// balance is already <= 0 is left out entirely (mirrors the sheet: a
// character owed nothing never got a Decay row). The math doesn't depend
// on which rate-decay mechanism is asking (expansion vs. global_cycle) —
// both apply `rate` to the same "balance before effectiveDate" — so this
// is shared as-is; kind only matters at commit time (label + duplicate
// guard) and to the caller deciding when to run it.
export async function previewRateDecay(db: ReturnType<typeof drizzle>, rate: number, cutoff: Date): Promise<DecayPreviewRow[]> {
  const [epUnits, gpUnits, allCharacters, allPlayers] = await Promise.all([
    unitBalances(db, epLedger, cutoff),
    unitBalances(db, gpLedger, cutoff),
    db.select({ id: characters.id, name: characters.name }).from(characters),
    db.select({ id: players.id, mainCharacterId: players.mainCharacterId }).from(players),
  ]);
  const names = new Map(allCharacters.map((c) => [c.id, c.name]));
  const mainByPlayer = new Map(allPlayers.map((p) => [p.id, p.mainCharacterId]));
  const keys = new Set([...epUnits.keys(), ...gpUnits.keys()]);

  // One row per account (see unitBalances): the net across all of its
  // characters is what gets decayed, written on the account's main.
  const rows: DecayPreviewRow[] = [];
  for (const key of keys) {
    const epUnit = epUnits.get(key);
    const gpUnit = gpUnits.get(key);
    const epBalance = epUnit?.net ?? 0;
    const gpBalance = gpUnit?.net ?? 0;
    if (epBalance <= 0 && gpBalance <= 0) continue;
    const playerId = (epUnit ?? gpUnit)?.playerId ?? null;
    const characterId = pickTargetCharacter(playerId, mainByPlayer, epUnit, gpUnit);
    rows.push({
      characterId,
      characterName: names.get(characterId) ?? `#${characterId}`,
      playerId,
      epBalance,
      // A rate may be rounded up to the nearest cent. Never let that (or an
      // accidentally excessive rate) take more than the available balance.
      epDecay: epBalance > 0 ? Math.min(round2(epBalance * rate), epBalance) : 0,
      gpBalance,
      gpDecay: gpBalance > 0 ? Math.min(round2(gpBalance * rate), gpBalance) : 0,
    });
  }
  rows.sort((a, b) => a.characterName.localeCompare(b.characterName));
  return rows;
}

// Guards against double-applying the same event (PLAN.md §2.5) — a
// reversed event doesn't block a redo on the same date. Scoped per kind: an
// expansion decay and a global_cycle decay landing on the same calendar
// date are different events and shouldn't collide with each other.
export async function findActiveRateDecayEvent(db: ReturnType<typeof drizzle>, kind: RateDecayKind, effectiveDate: Date) {
  const [row] = await db
    .select()
    .from(decayEvents)
    .where(and(eq(decayEvents.kind, kind), eq(decayEvents.effectiveDate, effectiveDate), isNull(decayEvents.reversedAt)));
  return row ?? null;
}

export type CommitDecayResult = { decayEventId: number; epRows: number; gpRows: number };
export type CommitDecayOutcome = CommitDecayResult | { error: string };

// Ledger activity/tier label per rate-decay kind. "Decay" for expansion
// matches the sheet import's label for the 3 historical events
// (scripts/import-epgp.ts / scripts/backfill-expansion-decay.ts key off
// this exact string), so it must stay as-is. global_cycle gets its own
// label so a leader reading the ledger can tell an expansion haircut from
// an ordinary 10%-compounding cycle decay at a glance.
const RATE_DECAY_LABEL: Record<RateDecayKind, string> = { expansion: "Decay", global_cycle: "Cycle Decay" };

// Writes one decay_events row plus every non-zero preview row as a linked
// negative ep_ledger/gp_ledger entry. Shared by expansion decay (§1b,
// Phase 2) and global cycle decay (§1c, Phase 5) — same mechanics, just a
// different kind/label/rate. Not a single D1 transaction (this codebase's
// other multi-row writes — bids, attendance — follow the same
// parent-row-first, sequential-insert shape; see bids/route.ts), but the
// decay_events row is meaningless with zero linked rows, so a failure
// partway through still leaves something reversible rather than
// silently-wrong totals.
export async function commitRateDecay(
  db: ReturnType<typeof drizzle>,
  opts: { kind: RateDecayKind; rate: number; effectiveDate: Date; cutoff?: Date; label?: string; appliedBy: string },
): Promise<CommitDecayOutcome> {
  const { kind, rate, effectiveDate, appliedBy } = opts;
  // Balances are summed strictly before `cutoff` (see resolveDecayCutoff);
  // callers that only have a label date keep the old behavior.
  const cutoff = opts.cutoff ?? effectiveDate;
  const label = opts.label?.trim() || null;

  const existing = await findActiveRateDecayEvent(db, kind, effectiveDate);
  if (existing) {
    return { error: `A ${kind} decay event already exists for ${ledgerDate(effectiveDate)} — reverse it first to redo.` };
  }

  const preview = await previewRateDecay(db, rate, cutoff);
  if (preview.length === 0) {
    return { error: "No characters have a positive EP or GP balance to decay as of that date." };
  }

  const [event] = await db
    .insert(decayEvents)
    .values({ kind, epRate: rate, gpRate: rate, effectiveDate, label, appliedBy })
    .returning();

  // Task 4.4: mark everyone dirty before writing a single decay row. This
  // write isn't itself one D1 transaction (see the file comment above —
  // a decay commit is a sequence of per-character inserts by design, so a
  // partial run still leaves something reversible), so the marker has to
  // land before that loop starts, not after: a crash on row 50 of 300
  // still leaves a global marker guaranteeing the repair pass or nightly
  // rebuild eventually recomputes everyone, not just the players this
  // particular run happened to reach.
  await markStandingsDirty(db, { all: true });

  const activityLabel = RATE_DECAY_LABEL[kind];
  let epRows = 0;
  let gpRows = 0;
  for (const row of preview) {
    if (row.epDecay > 0) {
      await db.insert(epLedger).values({
        characterId: row.characterId,
        playerId: row.playerId,
        occurredAt: effectiveDate,
        activity: activityLabel,
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
        playerId: row.playerId,
        occurredAt: effectiveDate,
        tier: activityLabel,
        points: -row.gpDecay,
        note: label,
        enteredBy: appliedBy,
        source: "manual",
        decayEventId: event.id,
      });
      gpRows++;
    }
  }

  await settleStandings(db, { all: true });

  await recordSystemEvent(db, await webActor(db, appliedBy), {
    action: "epgp.decay.commit",
    targetType: "decay_event",
    targetId: event.id,
    summary: `${kind} decay committed at rate ${rate} for ${ledgerDate(effectiveDate)} (${epRows} EP rows, ${gpRows} GP rows)${label ? ` — ${label}` : ""}`,
    after: { kind, rate, effectiveDate, epRows, gpRows, label },
  });

  return { decayEventId: event.id, epRows, gpRows };
}

export type DeparturePreviewRow = {
  characterId: number;
  characterName: string;
  // Same role as DecayPreviewRow.playerId — carried through to commit so
  // the wipe row it writes sets player_id (§11 Phase 3 task 3.11).
  playerId: number | null;
  epBalance: number;
  gpBalance: number;
  lastEpActivity: Date | null;
};

// §1f — a leader-searchable, non-destructive EP wipe ("removing any EP from
// players who haven't raided since the start of Velious"). GP is never
// touched, same asymmetry as every other departure-flavored write (§1e).
// `characterIds` (explicit selection, e.g. resolved from leader-typed
// names) and `inactiveSince` (nothing EP-earning on/after that date) are
// alternative selection modes, not combined — `characterIds` wins if both
// are given. A character already at 0 EP is left out; there's nothing to
// wipe and no zero-amount ledger row should ever be written.
export async function previewDepartureWipe(
  db: ReturnType<typeof drizzle>,
  opts: { characterIds?: number[]; inactiveSince?: Date },
): Promise<DeparturePreviewRow[]> {
  if (!opts.characterIds?.length && !opts.inactiveSince) return [];

  const [allCharacters, allPlayers, epUnits, gpUnits, lastActivity] = await Promise.all([
    db.select({ id: characters.id, name: characters.name, playerId: characters.playerId }).from(characters),
    db.select({ id: players.id, mainCharacterId: players.mainCharacterId }).from(players),
    unitBalances(db, epLedger),
    unitBalances(db, gpLedger),
    lastPositiveEpActivity(db),
  ]);
  const names = new Map(allCharacters.map((c) => [c.id, c.name]));
  const mainByPlayer = new Map(allPlayers.map((p) => [p.id, p.mainCharacterId]));

  // Wipes are per account (see unitBalances): wiping only the positive
  // character would leave a negative old-main balance behind. A selected
  // character selects its whole account.
  const selectedPlayers = new Set<number>();
  const selectedCharacters = new Set(opts.characterIds ?? []);
  for (const char of allCharacters) {
    if (char.playerId !== null && selectedCharacters.has(char.id)) selectedPlayers.add(char.playerId);
  }
  const idFilter = opts.characterIds?.length ? true : false;

  const rows: DeparturePreviewRow[] = [];
  for (const [key, epUnit] of epUnits) {
    const epBalance = epUnit.net;
    if (epBalance <= 0) continue;

    let last: Date | null = null;
    for (const characterId of epUnit.byCharacter.keys()) {
      const when = lastActivity.get(characterId);
      if (when && (last === null || when > last)) last = when;
    }

    if (idFilter) {
      const picked = (epUnit.playerId !== null && selectedPlayers.has(epUnit.playerId)) || [...epUnit.byCharacter.keys()].some((id) => selectedCharacters.has(id));
      if (!picked) continue;
    } else if (opts.inactiveSince) {
      if (last !== null && last >= opts.inactiveSince) continue; // has EP activity at/after the cutoff — still active
    }

    const gpUnit = gpUnits.get(key);
    const characterId = pickTargetCharacter(epUnit.playerId, mainByPlayer, epUnit, gpUnit);
    rows.push({
      characterId,
      characterName: names.get(characterId) ?? `#${characterId}`,
      playerId: epUnit.playerId,
      epBalance,
      gpBalance: gpUnit?.net ?? 0,
      lastEpActivity: last,
    });
  }
  rows.sort((a, b) => a.characterName.localeCompare(b.characterName));
  return rows;
}

export type CommitDepartureResult = { decayEventId: number; epRows: number };
export type CommitDepartureOutcome = CommitDepartureResult | { error: string };

// One decay_events row (kind "departure", ep_rate 1 — a full wipe, not a
// percentage; gp_rate null — GP untouched) plus one linked negative
// ep_ledger row per selected character, zeroing their EP. No duplicate-date
// guard like expansion decay: unlike a cycle-wide event, wiping different
// characters at different times is the normal use of this tool, not an
// error case — the only real guard is previewDepartureWipe already
// excluding anyone already at 0.
export async function commitDepartureWipe(
  db: ReturnType<typeof drizzle>,
  opts: { characterIds?: number[]; inactiveSince?: Date; label?: string; appliedBy: string },
): Promise<CommitDepartureOutcome> {
  const label = opts.label?.trim() || null;
  const preview = await previewDepartureWipe(db, opts);
  if (preview.length === 0) {
    return { error: "No characters matched — nothing to wipe." };
  }

  const effectiveDate = new Date();
  const [event] = await db
    .insert(decayEvents)
    .values({ kind: "departure", epRate: 1, gpRate: null, effectiveDate, label, appliedBy: opts.appliedBy })
    .returning();

  // Task 4.4 — see commitRateDecay's comment on why this goes before the
  // per-row loop rather than after. Scoped to exactly the players this
  // wipe touches (known up front from the preview), not a global marker —
  // more precise for the repair pass than recomputing everyone.
  const affectedPlayerIds = [...new Set(preview.map((r) => r.playerId).filter((id): id is number => id !== null))];
  if (affectedPlayerIds.length > 0) await markStandingsDirty(db, { playerIds: affectedPlayerIds });

  for (const row of preview) {
    await db.insert(epLedger).values({
      characterId: row.characterId,
      playerId: row.playerId,
      occurredAt: effectiveDate,
      activity: "Departure",
      points: -row.epBalance,
      note: label,
      enteredBy: opts.appliedBy,
      source: "manual",
      decayEventId: event.id,
    });
  }

  await settleStandings(db, { all: true });

  await recordSystemEvent(db, await webActor(db, opts.appliedBy), {
    action: "epgp.departure.commit",
    targetType: "decay_event",
    targetId: event.id,
    summary: `Departure EP wipe committed for ${preview.length} character(s)${label ? ` — ${label}` : ""}`,
    after: { epRows: preview.length, label, characterIds: preview.map((r) => r.characterId) },
  });

  return { decayEventId: event.id, epRows: preview.length };
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

  const d1 = db.$client;
  const activeEvent = "decay_event_id = ? AND EXISTS (SELECT 1 FROM decay_events WHERE id = ? AND reversed_at IS NULL)";
  const results = await d1.batch([
    d1.prepare(`SELECT count(*) AS count FROM ep_ledger WHERE ${activeEvent}`).bind(decayEventId, decayEventId),
    d1.prepare(`SELECT count(*) AS count FROM gp_ledger WHERE ${activeEvent}`).bind(decayEventId, decayEventId),
    d1.prepare(`
      INSERT INTO standings_dirty (scope, marked_at)
      SELECT 'all', unixepoch()
      WHERE EXISTS (SELECT 1 FROM decay_events WHERE id = ? AND reversed_at IS NULL)
      ON CONFLICT(scope) DO UPDATE SET marked_at = excluded.marked_at
    `).bind(decayEventId),
    prepareDeleteAudit(d1, "ep", activeEvent, [decayEventId, decayEventId], reversedBy),
    prepareDeleteAudit(d1, "gp", activeEvent, [decayEventId, decayEventId], reversedBy),
    d1.prepare(`DELETE FROM ep_ledger WHERE ${activeEvent}`).bind(decayEventId, decayEventId),
    d1.prepare(`DELETE FROM gp_ledger WHERE ${activeEvent}`).bind(decayEventId, decayEventId),
    d1.prepare("UPDATE decay_events SET reversed_at = unixepoch(), reversed_by = ? WHERE id = ? AND reversed_at IS NULL RETURNING id").bind(reversedBy, decayEventId),
  ]);

  const reversed = results[7]?.results.length === 1;
  if (!reversed) return { error: "This decay event was already reversed." };
  await settleStandings(db, { all: true });

  const count = (result: D1Result | undefined) => Number((result?.results[0] as { count?: number } | undefined)?.count ?? 0);
  const epRows = count(results[0]);
  const gpRows = count(results[1]);

  await recordSystemEvent(db, await webActor(db, reversedBy), {
    action: "epgp.decay.reverse",
    targetType: "decay_event",
    targetId: decayEventId,
    summary: `${event.kind} decay event #${decayEventId} reversed (${epRows} EP rows, ${gpRows} GP rows restored)`,
    before: { kind: event.kind, effectiveDate: event.effectiveDate },
  });

  return { ok: true, epRows, gpRows };
}
