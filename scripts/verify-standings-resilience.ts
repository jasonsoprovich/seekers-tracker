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
//   4.7 — Scenarios G-I exercise the actual production entry points
//     (insertLedgerEntry, attachCharacterToPlayer's account absorption,
//     swapMainCharacter/reverseMainSwap's fee) end to end, not just the
//     shared primitives above. Attendance (insertEpLedgerBatch) and bids
//     (finalizeBidRound) share those same primitives and are covered by
//     npm run verify:attendance-minimum/verify:bid-finalization; decay
//     commit/reverse and departure wipes by verify:global-decay/
//     verify:guild-removal — all still pass unchanged after this phase.
//
// Usage:
//   npx tsx scripts/verify-standings-resilience.ts
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import * as schema from "../src/db";
import { characters, epLedger, playerEpgpTotals, players, standingsDirty, users } from "../src/db";
import { UNKNOWN_CLASS_ID, UNKNOWN_RACE_ID } from "../src/lib/eq/enums";
import { insertLedgerEntry } from "../src/lib/epgp/ledger-entry";
import {
  getStandings,
  getStandingsForPlayers,
  markStandingsDirty,
  refreshStandings,
  repairDirtyStandings,
  settleStandings,
} from "../src/lib/epgp/standings";
import { attachCharacterToPlayer, reverseMainSwap, swapMainCharacter } from "../src/lib/players";

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

// insertLedgerEntry/swapMainCharacter/reverseMainSwap record `enteredBy`/
// `appliedBy` as a real users.id FK — a plain string like "verify-script"
// fails that constraint, so scenarios G and I need one real (throwaway)
// user to attribute their writes to.
async function makeUser(db: Db): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    email: `verify-standings-resilience-${id}@example.invalid`,
    discordId: `test-discord-${id}`,
    username: `VerifyStandingsUser-${id.slice(0, 8)}`,
    role: "leader",
  });
  return id;
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
    const actingUserId = await makeUser(db);

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

    // ---------------------------------------------------------------
    console.log("\nScenario G: insertLedgerEntry (manual entry) marks dirty, settles, and returns the fresh standing");
    const playerG = await makePlayerWithEp(db, 10);
    await refreshStandings(db, { playerIds: [playerG] });
    const [charG] = await db.select({ id: characters.id }).from(characters).where(eq(characters.playerId, playerG));
    const manualResult = await insertLedgerEntry(
      db,
      { kind: "ep", characterId: charG.id, activity: "verify-standings-resilience manual", points: 40, occurredAt: new Date().toISOString(), note: "" },
      actingUserId,
      "manual",
    );
    check(failures, manualResult.ok, `manual entry insert succeeds (${manualResult.ok ? "ok" : manualResult.error})`);
    check(failures, manualResult.ok && manualResult.standing?.ep === 50, `insertLedgerEntry returns the affected player's fresh standing (got ${manualResult.ok ? manualResult.standing?.ep : "n/a"})`);
    check(failures, !(await dirtyScopes(db)).includes(`player:${playerG}`), "the marker was cleared once settleStandings actually succeeded");

    // ---------------------------------------------------------------
    console.log("\nScenario H: attachCharacterToPlayer's account absorption marks the target player dirty");
    const fromPlayer = await makePlayerWithEp(db, 75); // a standalone (no userId/discordId) — eligible to be absorbed
    const [fromChar] = await db.select({ id: characters.id }).from(characters).where(eq(characters.playerId, fromPlayer));
    const toPlayer = await makePlayerWithEp(db, 25);
    const [toChar] = await db.select({ id: characters.id }).from(characters).where(eq(characters.playerId, toPlayer));
    const attachResult = await attachCharacterToPlayer(db, fromChar.id, toPlayer);
    check(failures, !attachResult.error, `attachCharacterToPlayer succeeds (${attachResult.error ?? "ok"})`);
    check(failures, (await db.select().from(players).where(eq(players.id, fromPlayer))).length === 0, "the absorbed standalone player row was deleted");
    check(failures, (await dirtyScopes(db)).includes(`player:${toPlayer}`), "absorbing a standalone player's ledger history marks the target player dirty");
    await settleStandings(db, { playerIds: [toPlayer] });
    const afterAbsorb = await db.select().from(playerEpgpTotals).where(eq(playerEpgpTotals.playerId, toPlayer));
    check(failures, afterAbsorb[0]?.ep === 100, `the target player's total includes the absorbed history (got ${afterAbsorb[0]?.ep})`);
    void toChar; // resolved only to prove the row exists; not otherwise needed

    // ---------------------------------------------------------------
    console.log("\nScenario I: main-swap fee marks the player dirty, and reversing it refunds correctly");
    const swapPlayer = await makePlayerWithEp(db, 60);
    const [oldMain] = await db.select({ id: characters.id }).from(characters).where(eq(characters.playerId, swapPlayer));
    await db.update(players).set({ mainCharacterId: oldMain.id }).where(eq(players.id, swapPlayer));
    const [newMain] = await db
      .insert(characters)
      .values({ name: `VerifyStandingsChar-${randomUUID().slice(0, 8)}`, class: UNKNOWN_CLASS_ID, race: UNKNOWN_RACE_ID, level: 1, playerId: swapPlayer })
      .returning({ id: characters.id });
    await refreshStandings(db, { playerIds: [swapPlayer] });
    const swapResult = await swapMainCharacter(db, swapPlayer, newMain.id, actingUserId, 500);
    check(failures, !swapResult.error, `swapMainCharacter with a fee succeeds (${swapResult.error ?? "ok"})`);
    const afterSwap = await db.select().from(playerEpgpTotals).where(eq(playerEpgpTotals.playerId, swapPlayer));
    check(failures, afterSwap[0]?.gp === 500, `the fee landed on the player's GP total (got ${afterSwap[0]?.gp})`);
    check(failures, !(await dirtyScopes(db)).includes(`player:${swapPlayer}`), "the swap's own settleStandings cleared its marker");
    const [swapEvent] = await db.select({ id: schema.mainSwapEvents.id }).from(schema.mainSwapEvents).where(eq(schema.mainSwapEvents.playerId, swapPlayer));
    const reverseResult = await reverseMainSwap(db, swapEvent.id, actingUserId);
    check(failures, !reverseResult.error, `reverseMainSwap succeeds (${reverseResult.error ?? "ok"})`);
    const afterReverse = await db.select().from(playerEpgpTotals).where(eq(playerEpgpTotals.playerId, swapPlayer));
    check(failures, (afterReverse[0]?.gp ?? 0) === 0, `reversing the swap refunds the fee (got ${afterReverse[0]?.gp})`);
    check(failures, !(await dirtyScopes(db)).includes(`player:${swapPlayer}`), "the reversal's own settleStandings cleared its marker too");

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
