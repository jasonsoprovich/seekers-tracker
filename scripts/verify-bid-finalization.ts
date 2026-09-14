// REMEDIATION-PLAN-2026-09-12.md Phase 3 task 3.8 — "Cover mid-write
// failures, client retry, duplicate drops, multiple winners, invalid rows,
// and standings-refresh failure."
//
// Exercises finalizeBidRound (src/lib/epgp/bid-finalization.ts) directly
// against local D1 — same technique as verify-guild-removal.ts — rather
// than through a live Worker request, since the core logic was pulled out
// of the POST /api/officer/bids route handler specifically so it doesn't
// need one. Snapshotted first and restored in a `finally` regardless of
// outcome, so the database is back to its pre-test state whether the
// assertions pass or fail. Never point this at remote D1.
//
// Usage:
//   npx tsx scripts/verify-bid-finalization.ts
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import * as schema from "../src/db";
import { bids, characters, gpLedger, lootEvents, players, playerEpgpTotals, users } from "../src/db";
import { finalizeBidRound } from "../src/lib/epgp/bid-finalization";
import { UNKNOWN_CLASS_ID, UNKNOWN_RACE_ID } from "../src/lib/eq/enums";

const SNAPSHOT_NAME = "phase3-bid-finalization-test";

type Db = ReturnType<typeof drizzle<typeof schema>>;

function check(failures: { n: number }, cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ok   ${msg}`);
  } else {
    console.log(`  FAIL ${msg}`);
    failures.n++;
  }
}

async function makeCharacter(db: Db, name: string) {
  const [player] = await db
    .insert(players)
    .values({ displayName: name, role: "member", status: "active" })
    .returning({ id: players.id });
  const [char] = await db
    .insert(characters)
    .values({ name, class: UNKNOWN_CLASS_ID, race: UNKNOWN_RACE_ID, level: 1, playerId: player.id })
    .returning({ id: characters.id });
  await db.update(players).set({ mainCharacterId: char.id }).where(eq(players.id, player.id));
  return { characterId: char.id, playerId: player.id };
}

async function main() {
  console.log(`Saving snapshot '${SNAPSHOT_NAME}' before running a destructive test...`);
  execFileSync("scripts/snapshot.sh", ["save", SNAPSHOT_NAME], { stdio: "inherit" });

  const failures = { n: 0 };
  const proxy = await getPlatformProxy({ configPath: "wrangler.jsonc" });

  try {
    const db = drizzle(proxy.env.DATABASE as unknown as Parameters<typeof drizzle>[0], { schema });
    const now = new Date();

    // gpLedger.enteredBy/lootEvents.openedBy both FK-reference users.id — a
    // plain made-up string trips the constraint, so mint a real officer
    // user the same way verify-guild-removal.ts does.
    const enteredBy = randomUUID();
    await db.insert(users).values({
      id: enteredBy,
      email: `verify-bid-finalization-${enteredBy}@example.invalid`,
      username: `VerifyOfficer-${enteredBy.slice(0, 8)}`,
      role: "officer",
    });

    const winnerName = `VerifyWinner${randomUUID().slice(0, 6)}`;
    const loserName = `VerifyLoser${randomUUID().slice(0, 6)}`;
    const secondWinnerName = `VerifySecondWinner${randomUUID().slice(0, 6)}`;
    const concurrentWinnerName = `VCW${randomUUID().slice(0, 6)}`;
    const winner = await makeCharacter(db, winnerName);
    const loser = await makeCharacter(db, loserName);
    const secondWinner = await makeCharacter(db, secondWinnerName);
    const concurrentWinner = await makeCharacter(db, concurrentWinnerName);

    // -----------------------------------------------------------------
    // Scenario A: a normal round with a submissionId — the loot event,
    // both bid rows, the winner pointer, and the GP charge should all
    // land atomically, and standings should reflect the charge.
    // -----------------------------------------------------------------
    console.log("\nScenario A: normal finalize (task 3.4 atomic write)");
    const itemA = `Verify Item A ${randomUUID().slice(0, 6)}`;
    const submissionIdA = randomUUID();
    const occurredAtA = now.toISOString();
    const resultA = await finalizeBidRound(
      db,
      {
        itemName: itemA,
        entries: [
          { characterName: winnerName, tier: "High Bid", occurredAt: occurredAtA, isWinner: true },
          { characterName: loserName, tier: "Medium Bid", occurredAt: occurredAtA, isWinner: false },
        ],
        submissionId: submissionIdA,
      },
      enteredBy,
    );
    check(failures, resultA.ok, `finalize succeeds (${resultA.ok ? "" : resultA.error})`);
    if (!resultA.ok) throw new Error("Scenario A did not succeed — aborting.");
    check(failures, resultA.status === 201, "status 201 on first write");
    check(failures, resultA.inserted === 2, `both bid rows inserted (got ${resultA.inserted})`);
    check(failures, !resultA.replay, "not flagged as a replay");

    const [lootEventA] = await db.select().from(lootEvents).where(eq(lootEvents.id, resultA.lootEventId));
    check(failures, lootEventA?.submissionId === submissionIdA, "loot event stored the submissionId");
    check(failures, lootEventA?.winningBidId != null, "winningBidId was set");

    const bidsA = await db.select().from(bids).where(eq(bids.lootEventId, resultA.lootEventId));
    check(failures, bidsA.length === 2, `two bid rows recorded (got ${bidsA.length})`);
    check(failures, bidsA.some((b) => b.characterId === winner.characterId && b.status === "won"), "winner's bid row is 'won'");
    check(failures, bidsA.some((b) => b.characterId === loser.characterId && b.status === "lost"), "loser's bid row is 'lost'");
    if (lootEventA?.winningBidId != null) {
      const winningBid = bidsA.find((b) => b.id === lootEventA.winningBidId);
      check(failures, winningBid?.characterId === winner.characterId, "winningBidId points at the winner's own bid row");
    }

    const gpA = await db.select().from(gpLedger).where(eq(gpLedger.characterId, winner.characterId));
    check(failures, gpA.length === 1 && gpA[0].points === 100, `winner charged exactly one High Bid GP row (got ${gpA.length} row(s))`);
    const gpLoserA = await db.select().from(gpLedger).where(eq(gpLedger.characterId, loser.characterId));
    check(failures, gpLoserA.length === 0, "loser was never charged GP");

    const [standingsA] = await db.select().from(playerEpgpTotals).where(eq(playerEpgpTotals.playerId, winner.playerId));
    check(failures, standingsA?.gp === 100, `standings refreshed for the winner's player (gp=${standingsA?.gp})`);

    // -----------------------------------------------------------------
    // Scenario B: retry with the SAME submissionId — task 3.5. Must
    // return the original result and must NOT charge GP again.
    // -----------------------------------------------------------------
    console.log("\nScenario B: retry with the same submissionId (task 3.5 idempotent replay)");
    const resultB = await finalizeBidRound(
      db,
      {
        itemName: itemA,
        entries: [
          { characterName: winnerName, tier: "High Bid", occurredAt: occurredAtA, isWinner: true },
          { characterName: loserName, tier: "Medium Bid", occurredAt: occurredAtA, isWinner: false },
        ],
        submissionId: submissionIdA,
      },
      enteredBy,
    );
    check(failures, resultB.ok, `retry still reports success (${resultB.ok ? "" : resultB.error})`);
    if (resultB.ok) {
      check(failures, resultB.replay === true, "retry is flagged as a replay");
      check(failures, resultB.lootEventId === resultA.lootEventId, "retry returns the SAME lootEventId");
      check(failures, resultB.status === 200, "replay status is 200, not 201");
    }
    const gpAfterRetry = await db.select().from(gpLedger).where(eq(gpLedger.characterId, winner.characterId));
    check(failures, gpAfterRetry.length === 1, `GP charged exactly once despite the retry (got ${gpAfterRetry.length} row(s))`);
    const bidsAfterRetry = await db.select().from(bids).where(eq(bids.lootEventId, resultA.lootEventId));
    check(failures, bidsAfterRetry.length === 2, "no duplicate bid rows from the retry");

    // -----------------------------------------------------------------
    // Scenario B2: simultaneous requests can both miss the initial replay
    // lookup. The unique constraint chooses one writer; the other must be
    // normalized into a replay response rather than surfacing a D1 error.
    // -----------------------------------------------------------------
    console.log("\nScenario B2: concurrent requests with the same submissionId");
    const concurrentSubmissionId = randomUUID();
    const concurrentItem = `Verify Concurrent Item ${randomUUID().slice(0, 6)}`;
    const concurrentBody = {
      itemName: concurrentItem,
      entries: [{ characterName: concurrentWinnerName, tier: "High Bid", occurredAt: now.toISOString(), isWinner: true }],
      submissionId: concurrentSubmissionId,
    };
    const concurrentResults = await Promise.all([
      finalizeBidRound(db, concurrentBody, enteredBy),
      finalizeBidRound(db, concurrentBody, enteredBy),
    ]);
    check(failures, concurrentResults.every((result) => result.ok), "both concurrent requests report success");
    if (concurrentResults.every((result) => result.ok)) {
      const successes = concurrentResults.filter((result) => result.ok);
      check(failures, successes[0].lootEventId === successes[1].lootEventId, "both requests return the same loot event");
      check(failures, successes.filter((result) => result.replay).length === 1, "exactly one request is normalized into a replay");
    }
    const concurrentLoot = await db.select().from(lootEvents).where(eq(lootEvents.submissionId, concurrentSubmissionId));
    const concurrentGp = await db.select().from(gpLedger).where(eq(gpLedger.characterId, concurrentWinner.characterId));
    check(failures, concurrentLoot.length === 1, "concurrent requests create one loot event");
    check(failures, concurrentGp.length === 1, "concurrent requests charge GP exactly once");

    // -----------------------------------------------------------------
    // Scenario C: item/time heuristic (task 3.6) — a DIFFERENT
    // submissionId for the same item name close in time is still a soft
    // 409 unless confirmDuplicate is set, and writes nothing on the 409.
    // -----------------------------------------------------------------
    console.log("\nScenario C: item/time duplicate heuristic (task 3.6, still a distinct check from 3.5)");
    const lootEventCountBeforeC = (await db.select().from(lootEvents)).length;
    const resultC1 = await finalizeBidRound(
      db,
      {
        itemName: itemA,
        entries: [{ characterName: winnerName, tier: "High Bid", occurredAt: occurredAtA, isWinner: true }],
        submissionId: randomUUID(),
      },
      enteredBy,
    );
    check(failures, !resultC1.ok && resultC1.status === 409, `same item/time without confirmDuplicate is rejected (status ${resultC1.ok ? resultC1.status : resultC1.status})`);
    check(failures, !resultC1.ok && resultC1.duplicate?.lootEventId === resultA.lootEventId, "409 names the original loot event");
    const lootEventCountAfterC1 = (await db.select().from(lootEvents)).length;
    check(failures, lootEventCountAfterC1 === lootEventCountBeforeC, "the rejected 409 attempt wrote nothing");

    const resultC2 = await finalizeBidRound(
      db,
      {
        itemName: itemA,
        entries: [{ characterName: winnerName, tier: "High Bid", occurredAt: occurredAtA, isWinner: true }],
        submissionId: randomUUID(),
        confirmDuplicate: true,
      },
      enteredBy,
    );
    check(failures, resultC2.ok, `confirmDuplicate:true records it anyway (${resultC2.ok ? "" : resultC2.error})`);
    if (resultC2.ok) check(failures, resultC2.lootEventId !== resultA.lootEventId, "confirmed duplicate is a genuinely new loot event");

    // -----------------------------------------------------------------
    // Scenario D: invalid rows — an unresolvable winner name rejects the
    // whole request and writes nothing.
    // -----------------------------------------------------------------
    console.log("\nScenario D: invalid winner name rejects before writing anything");
    const lootEventCountBeforeD = (await db.select().from(lootEvents)).length;
    const resultD = await finalizeBidRound(
      db,
      {
        itemName: `Verify Item D ${randomUUID().slice(0, 6)}`,
        entries: [{ characterName: "NoSuchCharacterAtAll", tier: "High Bid", occurredAt: now.toISOString(), isWinner: true }],
        submissionId: randomUUID(),
      },
      enteredBy,
    );
    check(failures, !resultD.ok && resultD.status === 422, `unresolvable winner is rejected (status ${resultD.ok ? "n/a" : resultD.status})`);
    const lootEventCountAfterD = (await db.select().from(lootEvents)).length;
    check(failures, lootEventCountAfterD === lootEventCountBeforeD, "nothing was written for the invalid round");

    // -----------------------------------------------------------------
    // Scenario E: multiple winners (a duplicate drop) — each gets its own
    // GP charge, and an unmatched non-winner row is reported, not fatal.
    // -----------------------------------------------------------------
    console.log("\nScenario E: multiple winners + an unmatched non-winner row");
    const itemE = `Verify Item E ${randomUUID().slice(0, 6)}`;
    const occurredAtE = now.toISOString();
    const resultE = await finalizeBidRound(
      db,
      {
        itemName: itemE,
        entries: [
          { characterName: winnerName, tier: "High Bid", occurredAt: occurredAtE, isWinner: true },
          { characterName: secondWinnerName, tier: "High Bid", occurredAt: occurredAtE, isWinner: true },
          { characterName: "SomeoneNotInTheRoster", tier: "Low Bid", occurredAt: occurredAtE, isWinner: false },
        ],
        submissionId: randomUUID(),
      },
      enteredBy,
    );
    check(failures, resultE.ok, `multi-winner round succeeds (${resultE.ok ? "" : resultE.error})`);
    if (resultE.ok) {
      check(failures, resultE.inserted === 2, `only the two resolvable rows were inserted (got ${resultE.inserted})`);
      check(failures, resultE.unmatched.includes("SomeoneNotInTheRoster"), "the unresolvable non-winner is reported as unmatched");
      const gpWinner1 = await db.select().from(gpLedger).where(eq(gpLedger.characterId, winner.characterId));
      const gpWinner2 = await db.select().from(gpLedger).where(eq(gpLedger.characterId, secondWinner.characterId));
      // gpWinner1 already has scenario A's 1 row and scenario C's confirmed-
      // duplicate charge (a genuine second win, correctly charged again) —
      // this round adds a third.
      check(failures, gpWinner1.length === 3, `first winner now has 3 GP rows total (got ${gpWinner1.length})`);
      check(failures, gpWinner2.length === 1, `second winner charged once (got ${gpWinner2.length})`);
    }

    console.log(failures.n === 0 ? "\nAll checks passed." : `\n${failures.n} check(s) FAILED.`);
  } finally {
    // Dispose the proxy's own Miniflare/D1 connection BEFORE restoring —
    // otherwise this process's still-open handle can flush its own
    // (pre-restore) state back over the restored file later, silently
    // undoing the restore (confirmed happening here: a leftover row
    // reappeared after "Restored snapshot" had already printed, until this
    // was added — same fix verify-guild-removal.ts/verify-global-decay.ts
    // already apply).
    await proxy.dispose();
    console.log(`\nRestoring snapshot '${SNAPSHOT_NAME}'...`);
    execFileSync("scripts/snapshot.sh", ["restore", SNAPSHOT_NAME], { stdio: "inherit" });
  }

  if (failures.n > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
