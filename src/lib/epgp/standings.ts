import { and, eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { drizzle } from "drizzle-orm/d1";

import { epLedger, gpLedger, playerEpgpTotals, standingsDirty } from "@/db";
import { timed } from "@/lib/perf";

import { recomputeAllCharacterLastActivity } from "./character-activity";
import { computeEpgpTotals, type EpgpTotal } from "./totals";

// Maintains the `player_epgp_totals` materialized table (see its schema
// comment). `computeEpgpTotals` stays the single source of the math; this
// module only decides *when* to persist its output and how to read it back
// cheaply. Every place that used to call `invalidateEpgpTotalsCache()` now
// calls `refreshStandings()` instead — same call sites, opposite direction
// (push the new numbers in, rather than blow a cache away and hope the next
// reader recomputes).

export type StandingsRow = EpgpTotal & { lastActivityAt: Date | null };

// Most-recent EP/GP occurredAt per player — the roster's "Last Attended"
// column, folded in here so a standings read is one table scan instead of
// roster/page.tsx running its own two GROUP BY max() queries over the full
// ledgers on every request.
async function lastActivityByPlayer(
  db: ReturnType<typeof drizzle>,
  playerFilter: number[] | null,
): Promise<Map<number, Date>> {
  const epScoped = playerFilter ? inArray(epLedger.playerId, playerFilter) : undefined;
  const gpScoped = playerFilter ? inArray(gpLedger.playerId, playerFilter) : undefined;
  const [ep, gp] = await Promise.all([
    db
      .select({ playerId: epLedger.playerId, lastAt: sql<number | null>`max(${epLedger.occurredAt})` })
      .from(epLedger)
      .where(and(epScoped))
      .groupBy(epLedger.playerId),
    db
      .select({ playerId: gpLedger.playerId, lastAt: sql<number | null>`max(${gpLedger.occurredAt})` })
      .from(gpLedger)
      .where(and(gpScoped))
      .groupBy(gpLedger.playerId),
  ]);
  const out = new Map<number, Date>();
  for (const r of [...ep, ...gp]) {
    if (r.playerId == null || r.lastAt == null) continue;
    const prev = out.get(r.playerId);
    // occurred_at is stored in seconds.
    if (!prev || r.lastAt * 1000 > prev.getTime()) out.set(r.playerId, new Date(r.lastAt * 1000));
  }
  return out;
}

type RefreshOpts =
  // Recompute exactly these players (a ledger insert/edit/delete's own
  // player) — cheap, index-seeked. A player id whose ledger rows are now
  // all gone has its totals row deleted.
  | { playerIds: number[]; asOf?: Date }
  // Recompute every player — used after a settings change (base/decay
  // rates move everyone's priority), any decay commit/reverse (touches
  // many players at once), a cycle rollover under decay_model=legacy, and
  // the initial backfill. Rows for players with no ledger history are
  // pruned.
  | { all: true; asOf?: Date };

export async function refreshStandings(db: ReturnType<typeof drizzle>, opts: RefreshOpts): Promise<void> {
  const asOf = opts.asOf ?? new Date();
  const scoped = "playerIds" in opts;
  const playerFilter = scoped ? opts.playerIds.filter((id): id is number => Number.isInteger(id) && id > 0) : null;

  // Nothing to do — e.g. a ledger row whose character has no player_id yet
  // (PLAN.md §16): it contributes to no total, same as computeEpgpTotals
  // excludes it.
  if (scoped && (playerFilter as number[]).length === 0) return;

  // Snapshot marker generations before reading the ledgers. A mutation that
  // lands while this refresh is running replaces its token; the conditional
  // delete at the end then leaves that newer work queued for repair.
  const coveredMarkers = scoped
    ? await db
        .select({ scope: standingsDirty.scope, markerToken: standingsDirty.markerToken })
        .from(standingsDirty)
        .where(inArray(standingsDirty.scope, (playerFilter as number[]).map(playerScope)))
    : await db.select({ scope: standingsDirty.scope, markerToken: standingsDirty.markerToken }).from(standingsDirty);

  const [totals, lastActivity] = await Promise.all([
    computeEpgpTotals(db, { asOf, ...(playerFilter ? { playerIds: playerFilter } : {}) }),
    lastActivityByPlayer(db, playerFilter),
  ]);

  const now = new Date();
  // Upserts go out as db.batch() chunks — one round trip (and one
  // transaction) per chunk instead of one per player. A full rebuild is
  // ~256 rows: 7 round trips, not 256; a 50-player attendance refresh is
  // 2, not 50. (2026-09-10 perf fix — this loop was a large share of the
  // 20-45s attendance submit.)
  const upserts = [...totals.values()].map((t) => {
    const row = {
      playerId: t.playerId,
      ep: t.ep,
      gp: t.gp,
      epDecay: t.epDecay,
      gpDecay: t.gpDecay,
      priorityRating: t.priorityRating,
      rawEp: t.rawEp,
      rawGp: t.rawGp,
      preCycleEp: t.preCycleEp,
      preCycleGp: t.preCycleGp,
      lastActivityAt: lastActivity.get(t.playerId) ?? null,
      updatedAt: now,
    };
    return db.insert(playerEpgpTotals).values(row).onConflictDoUpdate({ target: playerEpgpTotals.playerId, set: row });
  });
  const UPSERT_CHUNK = 40;
  for (let i = 0; i < upserts.length; i += UPSERT_CHUNK) {
    const chunk = upserts.slice(i, i + UPSERT_CHUNK);
    // drizzle's batch() wants a non-empty tuple type; the slice is never
    // empty here.
    await db.batch(chunk as unknown as [(typeof chunk)[number], ...(typeof chunk)[number][]]);
  }

  // Prune stale rows: a scoped refresh only revisits the ids it was asked
  // about that produced no total (all their rows deleted); a full refresh
  // drops anyone no longer in the ledger at all. Deletes are chunked —
  // Miniflare's D1 trips "too many SQL variables" well under SQLite's
  // nominal 999 (see scripts/import-sos-bot-dump.ts's note).
  let gone: number[];
  if (scoped) {
    gone = (playerFilter as number[]).filter((id) => !totals.has(id));
  } else {
    const existing = await db.select({ id: playerEpgpTotals.playerId }).from(playerEpgpTotals);
    gone = existing.map((r) => r.id).filter((id) => !totals.has(id));
  }
  for (let i = 0; i < gone.length; i += 90) {
    await db.delete(playerEpgpTotals).where(inArray(playerEpgpTotals.playerId, gone.slice(i, i + 90)));
  }

  // A write just landed — drop the read cache so this isolate serves fresh
  // numbers immediately (LT-26 #4). Other isolates fall back to the 10s TTL.
  standingsCache = undefined;

  // Task 4.5: only clear a dirty marker once its refresh has actually
  // landed. A full refresh clears every marker (a global rebuild subsumes
  // any single-player one); a scoped refresh clears exactly the players it
  // was asked to cover, whether or not each still has a total row (a
  // player pruned above still got its recompute attempted).
  if (scoped) {
    await deleteDirtyMarkers(db, coveredMarkers);
  } else {
    await deleteDirtyMarkers(db, coveredMarkers);
  }
}

// ---------------------------------------------------------------------------
// Durable dirty markers (remediation plan Phase 4 tasks 4.4/4.5).
//
// player_epgp_totals is a materialized cache of computeEpgpTotals — every
// write path calls refreshStandings right after its ledger mutation to keep
// it current. But that's two separate operations: if the ledger write
// commits and the recompute+upsert that follows then fails (a D1 hiccup, a
// request that got evicted), the mismatch was previously silent and
// invisible until the nightly 09:17 UTC rebuild caught it — up to ~24h of a
// wrong roster/priority number with no record anything had gone wrong.
//
// `standingsDirty` is a durable "this needs a refresh" marker, written
// alongside the authoritative ledger mutation (in the SAME db.batch() call
// wherever the mutation already batches its rows — bid-finalization.ts,
// insertEpLedgerBatch; a single dedicated statement immediately adjacent to
// the write where it doesn't, matching this codebase's existing
// not-one-transaction-but-structured-to-stay-recoverable pattern for those
// paths — see decay.ts's own comment on the same tradeoff). refreshStandings
// clears exactly the markers it covers once it actually succeeds; a marker
// that survives means the repair pass (the 2-minute cron, see
// custom-worker.ts) or the nightly full rebuild still owes that refresh.
function playerScope(playerId: number): string {
  return `player:${playerId}`;
}
const GLOBAL_SCOPE = "all";

type DirtyMarkerGeneration = { scope: string; markerToken: string };

async function deleteDirtyMarkers(db: ReturnType<typeof drizzle>, markers: DirtyMarkerGeneration[]): Promise<void> {
  for (let i = 0; i < markers.length; i += 40) {
    const statements = markers.slice(i, i + 40).map((marker) =>
      db
        .delete(standingsDirty)
        .where(and(eq(standingsDirty.scope, marker.scope), eq(standingsDirty.markerToken, marker.markerToken))),
    );
    if (statements.length > 0) {
      await db.batch(statements as unknown as [(typeof statements)[number], ...(typeof statements)[number][]]);
    }
  }
}

export type StandingsTarget = { playerIds: number[] } | { all: true };

// Statement builders (not yet executed) for inclusion in a caller's own
// db.batch() array, so the dirty marker commits atomically with the ledger
// rows that made it necessary — task 4.4's literal "same transaction."
// `onConflictDoUpdate` rather than `onConflictDoNothing` so a marker that's
// already there gets its markedAt bumped instead of being silently skipped
// — harmless either way, but keeps "how long has this been dirty" honest
// for anyone inspecting the table by hand.
export function dirtyMarkerStatements(db: ReturnType<typeof drizzle>, target: StandingsTarget): BatchItem<"sqlite">[] {
  const markerToken = crypto.randomUUID();
  if ("all" in target) {
    return [
      db
        .insert(standingsDirty)
        .values({ scope: GLOBAL_SCOPE, markerToken })
        .onConflictDoUpdate({ target: standingsDirty.scope, set: { markerToken, markedAt: new Date() } }) as unknown as BatchItem<"sqlite">,
    ];
  }
  const ids = [...new Set(target.playerIds.filter((id): id is number => Number.isInteger(id) && id > 0))];
  return ids.map(
    (id) =>
      db
        .insert(standingsDirty)
        .values({ scope: playerScope(id), markerToken })
        .onConflictDoUpdate({ target: standingsDirty.scope, set: { markerToken, markedAt: new Date() } }) as unknown as BatchItem<"sqlite">,
  );
}

// One dirty-marker write, executed immediately (not part of a larger
// batch) — for call sites whose own ledger write isn't already inside a
// db.batch(). Safe to call before or after that write; either way it lands
// well before the much more expensive/failure-prone refreshStandings call
// that follows.
export async function markStandingsDirty(db: ReturnType<typeof drizzle>, target: StandingsTarget): Promise<void> {
  const markerToken = crypto.randomUUID();
  if ("all" in target) {
    await db
      .insert(standingsDirty)
      .values({ scope: GLOBAL_SCOPE, markerToken })
      .onConflictDoUpdate({ target: standingsDirty.scope, set: { markerToken, markedAt: new Date() } });
    return;
  }
  const ids = [...new Set(target.playerIds.filter((id): id is number => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return;
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40).map((id) =>
      db
        .insert(standingsDirty)
        .values({ scope: playerScope(id), markerToken })
        .onConflictDoUpdate({ target: standingsDirty.scope, set: { markerToken, markedAt: new Date() } }),
    );
    await db.batch(chunk as unknown as [(typeof chunk)[number], ...(typeof chunk)[number][]]);
  }
}

// Attempts the actual recompute; on failure, logs and swallows rather than
// throwing back into the caller's mutation — the mutation's own ledger write
// already succeeded, and the durable dirty marker (already written, by the
// time any call site reaches this) guarantees the repair pass or the
// nightly rebuild will finish the job. Every refreshStandings call site in
// this codebase that follows a ledger mutation should go through this
// instead of calling refreshStandings directly (task 4.6) — a straight
// `await refreshStandings(...)` is still correct for a caller with nothing
// durable to fall back on (there are none left after this phase; kept as a
// separate export because scripts/recompute-standings-style callers with no
// preceding ledger write have no marker to leave behind either way).
export async function settleStandings(db: ReturnType<typeof drizzle>, target: StandingsTarget): Promise<boolean> {
  try {
    await refreshStandings(db, target);
    return true;
  } catch (err) {
    console.error(`[standings] refresh failed, leaving dirty marker(s) for the repair pass: ${err}`);
    return false;
  }
}

// The 2-minute cron's lightweight repair pass (task 4.5) — cheap to run
// often since the common case is an empty table (a no-op `SELECT` and
// nothing else). A lingering "all" marker means some full-table refresh
// (a decay commit/reverse, a settings change) didn't finish; that
// subsumes every player-scoped marker, so it's handled alone. Otherwise,
// one scoped refresh covers every dirty player at once. Best-effort and
// silent on failure, same as this cron's other steps — a marker that
// survives this too just waits for the next 2-minute tick or the nightly
// full rebuild.
export async function repairDirtyStandings(db: ReturnType<typeof drizzle>): Promise<{ scopes: number }> {
  const rows = await db.select({ scope: standingsDirty.scope }).from(standingsDirty);
  if (rows.length === 0) return { scopes: 0 };

  if (rows.some((r) => r.scope === GLOBAL_SCOPE)) {
    await settleStandings(db, { all: true });
  } else {
    const playerIds = rows
      .map((r) => (r.scope.startsWith("player:") ? Number(r.scope.slice("player:".length)) : NaN))
      .filter((id) => Number.isInteger(id) && id > 0);
    for (let i = 0; i < playerIds.length; i += 40) {
      await settleStandings(db, { playerIds: playerIds.slice(i, i + 40) });
    }
  }

  // Report only markers that are actually gone. This remains truthful when
  // a refresh fails or a concurrent mutation replaces a marker generation.
  const remaining = new Set((await db.select({ scope: standingsDirty.scope }).from(standingsDirty)).map((r) => r.scope));
  return { scopes: rows.filter((r) => !remaining.has(r.scope)).length };
}

// One-call "recompute everyone" for the /epgp/settings "Rebuild standings"
// button and the POST /api/officer/standings/rebuild route — the in-Worker
// equivalent of `npm run recompute:standings`, which only ever runs against
// local D1 (getPlatformProxy). Use it after applying a raw sheet-sync .sql
// to remote with `wrangler d1 execute --remote` (those plain INSERTs never
// go through refreshStandings, so the materialized table is left stale), or
// any time the roster looks out of step with the ledger. Returns the row
// count so the caller can report "rebuilt N players". Writes ~one row per
// player — trivial against D1's 100K/day write cap.
export async function rebuildAllStandings(db: ReturnType<typeof drizzle>): Promise<{ players: number }> {
  await refreshStandings(db, { all: true });
  // Heal characters.last_activity_at drift too (the roster/dashboard/
  // progression "recently active" filter reads it) — same recompute
  // migration 0031 ran; the nightly scheduled job goes through here.
  await recomputeAllCharacterLastActivity(db);
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(playerEpgpTotals);
  return { players: Number(row?.n ?? 0) };
}

// Short in-isolate cache (post-live-test-1 LT-26 #4). player_epgp_totals
// only changes on a ledger/decay/settings write, all of which go through
// refreshStandings — which busts this. Between writes it's a fixed
// ~256-row table read on every /roster, /dashboard and Totals-tab render;
// a 10s TTL lets repeat renders on the same warm isolate skip the D1
// round-trip entirely (~25-40ms each). Worst case: an officer submits and
// then checks the roster within 10s and sees the pre-write numbers on a
// stale isolate — acceptable for a display, and same-isolate writes clear
// it immediately.
const STANDINGS_TTL_MS = 10_000;
let standingsCache: { at: number; data: Map<number, StandingsRow> } | undefined;

export function bustStandingsCache(): void {
  standingsCache = undefined;
}

function rowToStandingsRow(r: typeof playerEpgpTotals.$inferSelect): StandingsRow {
  return {
    playerId: r.playerId,
    ep: r.ep,
    gp: r.gp,
    epDecay: r.epDecay,
    gpDecay: r.gpDecay,
    priorityRating: r.priorityRating,
    rawEp: r.rawEp,
    rawGp: r.rawGp,
    preCycleEp: r.preCycleEp,
    preCycleGp: r.preCycleGp,
    lastActivityAt: r.lastActivityAt ?? null,
  };
}

// The read path that replaces getCachedEpgpTotals — one scan of a
// ~one-row-per-player table. Shape-compatible with what computeEpgpTotals
// returned (a Map keyed by playerId) so callers only change the import,
// plus `lastActivityAt` for the roster.
export async function getStandings(db: ReturnType<typeof drizzle>): Promise<Map<number, StandingsRow>> {
  if (standingsCache && Date.now() - standingsCache.at < STANDINGS_TTL_MS) return standingsCache.data;
  const rows = await timed("getStandings", () => db.select().from(playerEpgpTotals));
  const out = new Map<number, StandingsRow>();
  for (const r of rows) out.set(r.playerId, rowToStandingsRow(r));
  standingsCache = { at: Date.now(), data: out };
  return out;
}

// Tasks 4.1/4.2 — a targeted read for one or a few players that never
// touches the whole-table 10s cache above: a direct, index-seeked
// `WHERE player_id IN (...)` scan against player_epgp_totals every time.
// For the small counts this is meant for (a mutation's own affected
// player(s), an account page's one player) that's cheap enough to always
// be strictly fresh rather than risk the up-to-10s-old snapshot a
// different, still-warm isolate's cache could otherwise hand back right
// after a write on this one. A player with no row (no ledger history) is
// simply absent from the returned map, same as getStandings.
export async function getStandingsForPlayers(db: ReturnType<typeof drizzle>, playerIds: number[]): Promise<Map<number, StandingsRow>> {
  const ids = [...new Set(playerIds.filter((id): id is number => Number.isInteger(id) && id > 0))];
  const out = new Map<number, StandingsRow>();
  if (ids.length === 0) return out;
  for (let i = 0; i < ids.length; i += 90) {
    const rows = await db.select().from(playerEpgpTotals).where(inArray(playerEpgpTotals.playerId, ids.slice(i, i + 90)));
    for (const r of rows) out.set(r.playerId, rowToStandingsRow(r));
  }
  return out;
}
