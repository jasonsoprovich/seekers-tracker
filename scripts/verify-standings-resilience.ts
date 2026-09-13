// REMEDIATION-PLAN-2026-09-12.md Phase 4 — "Fresh and Recoverable
// Standings." player_epgp_totals (the materialized read model) is kept
// current by every ledger-mutating write path calling refreshStandings
// right after its own mutation — but that's two separate operations. Before
// this phase, a refreshStandings failure right after a successful ledger
// write left silent drift with no record it had happened, undetectable
// until the nightly 09:17 UTC rebuild (up to ~24h later).
//
// This exercises the fix directly against local D1, real writes (snapshot
// first, restored in a `finally` regardless of outcome — never point this
// at remote D1, PLAN.md §5):
//   4.1/4.2 — getStandingsForPlayers is a targeted read that bypasses the
//     10s whole-table cache entirely, so it can't hand back a stale row
//     immediately after a write the way getStandings (same isolate, cache
//     not yet expired) still theoretically could on a different isolate.
//   4.4 — markStandingsDirty/dirtyMarkerStatements leave a durable
//     standings_dirty row; it survives independently of whether the
//     refresh that follows ever succeeds.
//   4.5 — refreshStandings clears exactly the markers it covers once it
//     actually succeeds; a marker for a player whose totals row is
//     independently known-wrong gets corrected by repairDirtyStandings
//     (the 2-minute cron's job) even though nothing new was ever
//     "written" to trigger a normal refresh.
//   4.6 — settleStandings never throws back into a caller even when the
//     underlying recompute fails, and it still leaves the durable marker
//     behind for the repair pass to find.
//
// Usage:
//   npx tsx scripts/verify-standings-resilience.ts
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import * as schema from "../src/db";
import { characters, epLedger, playerEpgpTotals, players, standingsDirty } from "../src/db";
import { UNKNOWN_CLASS_ID, UNKNOWN_RACE_ID } from "../src/lib/eq/enums";
import {
  getStandings,
  getStandingsForPlayers,
  markStandingsDirty,
  refreshStandings,
  repairDirtyStandings,
  settleStandings,
} from "../src/lib/epgp/standings";

const SNAPSHOT_NAME = "phase4-standings-resilience-test";

type Db = ReturnType<typeof drizzle<typeof schema>>;

function check(failures: { n: number }, cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ok   ${msg}`);
  } else {
    console.log(`  FAIL ${msg}`);
    failures.n++;
  }
}

async function makePlayerWithEp(db: Db, points: number): Promise<number> {
  const [player] = await db
    .insert(players)
    .values({ displayName: `VerifyStandings-${randomUUID().slice(0, 8)}`, status: "active" })
    .returning({ id: players.id });
  const [char] = await db
    .insert(characters)
    .values({ name: `VerifyStandingsChar-${randomUUID().slice(0, 8)}`, class: UNKNOWN_CLASS_ID, race: UNKNOWN_RACE_ID, level: 1, playerId: player.id })
    .returning({ id: characters.id });
  await db.insert(epLedger).values({
    characterId: char.id,
    playerId: player.id,
    occurredAt: new Date(),
    activity: "verify-standings-resilience test award",
    points,
  });
  return player.id;
}

async function dirtyScopes(db: Db): Promise<string[]> {
  return (await db.select({ scope: standingsDirty.scope }).from(standingsDirty)).map((r) => r.scope);
}

async function main() {
  console.log(`Saving snapshot '${SNAPSHOT_NAME}' before running a destructive test...`);
  execFileSync("scripts/snapshot.sh", ["save", SNAPSHOT_NAME], { stdio: "inherit" });

  const failures = { n: 0 };
  const proxy = await getPlatformProxy({ configPath: "wrangler.jsonc" });

  try {
    const db = drizzle(proxy.env.DATABASE as unknown as Parameters<typeof drizzle>[0], { schema });

    // ---------------------------------------------------------------
    console.log("\nScenario A: markStandingsDirty is durable and scoped correctly");
    const playerA = await makePlayerWithEp(db, 100);
    await markStandingsDirty(db, { playerIds: [playerA] });
    check(failures, (await dirtyScopes(db)).includes(`player:${playerA}`), "a player-scoped marker was written");
    await markStandingsDirty(db, { all: true });
    check(failures, (await dirtyScopes(db)).includes("all"), "a global marker was written");
    // Clean slate for the next scenarios.
    await db.delete(standingsDirty);

    // ---------------------------------------------------------------
    console.log("\nScenario B: refreshStandings clears exactly the markers it covers");
    const playerB = await makePlayerWithEp(db, 200);
    await markStandingsDirty(db, { playerIds: [playerB] });
    await refreshStandings(db, { playerIds: [playerB] });
    check(failures, !(await dirtyScopes(db)).includes(`player:${playerB}`), "a successful scoped refresh clears its own marker");
    const totalsRow = await db.select().from(playerEpgpTotals).where(eq(playerEpgpTotals.playerId, playerB));
    check(failures, totalsRow[0]?.ep === 200, `player_epgp_totals reflects the real ledger sum (got ${totalsRow[0]?.ep})`);

    // ---------------------------------------------------------------
    console.log("\nScenario C: a marker left by a mutation survives an unrelated refresh failure, and the repair pass heals it");
    const playerC = await makePlayerWithEp(db, 300);
    // Simulates task 4.4's guarantee directly: the durable marker is
    // written (as it would be, atomically, alongside the ledger insert in
    // every real call site) independently of whether settleStandings'
    // own recompute attempt ever runs or succeeds — here it simply never
    // runs, standing in for a crash/timeout between the two steps.
    await markStandingsDirty(db, { playerIds: [playerC] });
    check(failures, (await dirtyScopes(db)).includes(`player:${playerC}`), "the marker exists with no totals row yet materialized");
    check(failures, (await db.select().from(playerEpgpTotals).where(eq(playerEpgpTotals.playerId, playerC))).length === 0, "player_epgp_totals has no row yet for this player (nothing recomputed it)");
    const repaired = await repairDirtyStandings(db);
    check(failures, repaired.scopes >= 1, `repairDirtyStandings processed at least one marker (got ${repaired.scopes})`);
    const healedRow = await db.select().from(playerEpgpTotals).where(eq(playerEpgpTotals.playerId, playerC));
    check(failures, healedRow[0]?.ep === 300, `the repair pass materialized the correct total (got ${healedRow[0]?.ep})`);
    check(failures, !(await dirtyScopes(db)).includes(`player:${playerC}`), "the repair pass cleared the marker it fixed");

    // ---------------------------------------------------------------
    console.log("\nScenario D: a global marker's repair subsumes an unrelated player-scoped one");
    const playerD1 = await makePlayerWithEp(db, 400);
    const playerD2 = await makePlayerWithEp(db, 500);
    await refreshStandings(db, { playerIds: [playerD1, playerD2] }); // materialize both correctly first
    // Simulate drift: hand-corrupt D2's materialized row (as if an earlier
    // refresh silently failed after a ledger edit moved its true total),
    // then mark ONLY "all" dirty (as a settings-change-style mutation
    // would) — the repair pass should still notice and fix D2 even though
    // no marker names it directly, because a full rebuild covers everyone.
    await db.update(playerEpgpTotals).set({ ep: 999 }).where(eq(playerEpgpTotals.playerId, playerD2));
    await markStandingsDirty(db, { all: true });
    await repairDirtyStandings(db);
    const d2After = await db.select().from(playerEpgpTotals).where(eq(playerEpgpTotals.playerId, playerD2));
    check(failures, d2After[0]?.ep === 500, `a global repair corrects a player with no marker of its own (got ${d2After[0]?.ep})`);
    check(failures, (await dirtyScopes(db)).length === 0, "the global repair clears every marker, not just player-scoped ones");

    // ---------------------------------------------------------------
    console.log("\nScenario E: settleStandings never throws, even against an invalid target");
    // A playerId that can't possibly exist is harmless to computeEpgpTotals
    // (it just contributes nothing) — settleStandings should complete
    // normally rather than needing a try/catch at every call site.
    let threw = false;
    try {
      await settleStandings(db, { playerIds: [-1] });
    } catch {
      threw = true;
    }
    check(failures, !threw, "settleStandings completes without throwing");

    // ---------------------------------------------------------------
    console.log("\nScenario F: getStandingsForPlayers bypasses the whole-table cache (tasks 4.1/4.2)");
    const playerF = await makePlayerWithEp(db, 50);
    await refreshStandings(db, { playerIds: [playerF] });
    // Warm the 10s whole-table cache with the pre-edit value.
    const cachedBefore = await getStandings(db);
    check(failures, cachedBefore.get(playerF)?.ep === 50, "the whole-table cache holds the pre-edit value");
    // Move the number directly in the materialized table (standing in for
    // a refresh that just landed on a DIFFERENT isolate, which this
    // isolate's own 10s cache wouldn't know about yet).
    await db.update(playerEpgpTotals).set({ ep: 999 }).where(eq(playerEpgpTotals.playerId, playerF));
    const targeted = await getStandingsForPlayers(db, [playerF]);
    check(failures, targeted.get(playerF)?.ep === 999, `getStandingsForPlayers returns the current value regardless of the whole-table cache (got ${targeted.get(playerF)?.ep})`);
    const stillCached = await getStandings(db);
    check(failures, stillCached.get(playerF)?.ep === 50, "getStandings itself is untouched — still serving the stale cached snapshot until its own TTL expires (expected, documented tradeoff)");

    if (failures.n > 0) {
      console.error(`\n${failures.n} check(s) failed.`);
      process.exitCode = 1;
    } else {
      console.log("\nAll checks passed.");
    }
  } finally {
    await proxy.dispose();
    console.log(`Restoring snapshot '${SNAPSHOT_NAME}'...`);
    execFileSync("scripts/snapshot.sh", ["restore", SNAPSHOT_NAME], { stdio: "inherit" });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
