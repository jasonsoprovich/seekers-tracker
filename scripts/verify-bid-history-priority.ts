// REMEDIATION-PLAN-2026-09-12.md Phase 7 — "Bid-History Priority Clarity."
// The stored `bids.prioritySnapshot` ("Recorded PR") is calculated when a
// round is RECORDED, not necessarily at the raw tell's own timestamp, and
// never changes after the fact. "Current PR" (task 7.2) is a live read of
// the standings for whoever the bid is durably tied to — bids.playerId,
// captured at bid-finalization time (task 7.3) — not re-derived from the
// bid's character's CURRENT owner, so a later reassignment/absorption can't
// silently swap in an unrelated person's priority.
//
// Exercises the real write path (finalizeBidRound), the real absorption
// path (attachCharacterToPlayer -> absorbStandalonePlayer), and the real
// read path (listBidHistory) against local D1 — snapshotted first, restored
// in a `finally` regardless of outcome. Never point this at remote D1
// (PLAN.md §5).
//
// Covers, per task 7.5:
//   - historical: Recorded PR stays frozen after the player's later
//     standing changes; Current PR reflects the change.
//   - null: a bid on a character with no player at all has both playerId
//     and Current PR null (a plain read has nothing to compare against).
//   - reassigned/absorbed: a bid recorded while its character belonged to a
//     standalone player moves to the real account that later absorbs that
//     player (attachCharacterToPlayer's absorption path) — Current PR
//     tracks the SAME real person post-absorption, not the now-deleted
//     standalone player and not a re-derived "whoever owns the character
//     today" that a naive read could get wrong for other reasons.
//
// Usage:
//   npx tsx scripts/verify-bid-history-priority.ts
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import * as schema from "../src/db";
import { bids, characters, epLedger, players, users } from "../src/db";
import { UNKNOWN_CLASS_ID, UNKNOWN_RACE_ID } from "../src/lib/eq/enums";
import { finalizeBidRound } from "../src/lib/epgp/bid-finalization";
import { listBidHistory } from "../src/lib/epgp/ledger-list";
import { refreshStandings } from "../src/lib/epgp/standings";
import { attachCharacterToPlayer } from "../src/lib/players";

const SNAPSHOT_NAME = "phase7-bid-history-priority-test";

type Db = ReturnType<typeof drizzle<typeof schema>>;

function check(failures: { n: number }, cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ok   ${msg}`);
  } else {
    console.log(`  FAIL ${msg}`);
    failures.n++;
  }
}

async function makeUser(db: Db) {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    email: `verify-bid-history-${id}@example.invalid`,
    discordId: `test-discord-${id}`,
    username: `VerifyOfficer-${id.slice(0, 8)}`,
    role: "leader",
    discordVerified: true,
  });
  return id;
}

async function makeStandalonePlayer(db: Db) {
  const [row] = await db
    .insert(players)
    .values({
      userId: null,
      discordId: null,
      displayName: `VerifyPlayer-${randomUUID().slice(0, 8)}`,
      role: "member",
      status: "active",
    })
    .returning({ id: players.id });
  return row.id;
}

async function makeCharacter(db: Db, opts: { playerId: number | null; name: string }) {
  const [row] = await db
    .insert(characters)
    .values({
      playerId: opts.playerId,
      name: opts.name,
      class: UNKNOWN_CLASS_ID,
      race: UNKNOWN_RACE_ID,
      level: 1,
      charType: "main",
    })
    .returning({ id: characters.id });
  return row.id;
}

async function grantEp(db: Db, characterId: number, playerId: number, points: number) {
  await db.insert(epLedger).values({ characterId, playerId, occurredAt: new Date(), activity: "Manual Adjustment", points });
  await refreshStandings(db, { playerIds: [playerId] });
}

async function main() {
  console.log(`Saving snapshot '${SNAPSHOT_NAME}' before running a destructive test...`);
  execFileSync("scripts/snapshot.sh", ["save", SNAPSHOT_NAME], { stdio: "inherit" });

  const failures = { n: 0 };
  const proxy = await getPlatformProxy({ configPath: "wrangler.jsonc" });

  try {
    const db = drizzle(proxy.env.DATABASE as unknown as Parameters<typeof drizzle>[0], { schema });
    const officerId = await makeUser(db);

    // ---------------------------------------------------------------
    // Scenario 1 (historical): Recorded PR stays frozen; Current PR moves.
    // ---------------------------------------------------------------
    console.log("\nScenario 1: Recorded PR frozen, Current PR reflects a later change");
    const player1 = await makeStandalonePlayer(db);
    const char1 = await makeCharacter(db, { playerId: player1, name: "VerifyBidderHistorical" });
    await grantEp(db, char1, player1, 1000);

    const result1 = await finalizeBidRound(
      db,
      { itemName: "Verify Test Item 1", entries: [{ characterName: "VerifyBidderHistorical", tier: "High Bid", occurredAt: new Date().toISOString(), isWinner: true }] },
      officerId,
    );
    check(failures, result1.ok, `finalizeBidRound succeeds (${!result1.ok ? result1.error : "ok"})`);

    const [rawBid1] = await db.select({ playerId: bids.playerId, recordedPr: bids.prioritySnapshot }).from(bids).where(eq(bids.characterId, char1));
    check(failures, rawBid1?.playerId === player1, "new bid row captured player_id at write time (task 7.3)");
    check(failures, rawBid1?.recordedPr !== null && rawBid1.recordedPr !== undefined, "new bid row captured a priority snapshot");

    // Move the player's standing — Recorded PR must NOT follow this.
    await grantEp(db, char1, player1, 5000);

    const history1 = await listBidHistory(db, { q: "VerifyBidderHistorical" });
    const row1 = history1.rows.find((r) => r.characterName === "VerifyBidderHistorical");
    check(failures, row1 !== undefined, "bid history row found");
    check(failures, row1?.prioritySnapshot === rawBid1?.recordedPr, "Recorded PR is unchanged by the later EP grant");
    check(failures, row1?.currentPriority !== null, "Current PR is set");
    check(failures, row1!.currentPriority! > row1!.prioritySnapshot!, "Current PR reflects the later increase; Recorded PR does not");

    // ---------------------------------------------------------------
    // Scenario 2 (null): a bid on a character with no player at all.
    // ---------------------------------------------------------------
    console.log("\nScenario 2: no player identity to compare against");
    const char2 = await makeCharacter(db, { playerId: null, name: "VerifyBidderNoPlayer" });
    const result2 = await finalizeBidRound(
      db,
      { itemName: "Verify Test Item 2", entries: [{ characterName: "VerifyBidderNoPlayer", tier: "High Bid", occurredAt: new Date().toISOString(), isWinner: true }] },
      officerId,
    );
    check(failures, result2.ok, `finalizeBidRound succeeds for a player-less character (${!result2.ok ? result2.error : "ok"})`);

    const [rawBid2] = await db.select({ playerId: bids.playerId }).from(bids).where(eq(bids.characterId, char2));
    check(failures, rawBid2?.playerId === null, "a bid on a player-less character captures no player_id");

    const history2 = await listBidHistory(db, { q: "VerifyBidderNoPlayer" });
    const row2 = history2.rows.find((r) => r.characterName === "VerifyBidderNoPlayer");
    check(failures, row2 !== undefined, "bid history row found");
    check(failures, row2?.currentPriority === null, "Current PR is null — nothing to compare against, not a wrong guess");

    // ---------------------------------------------------------------
    // Scenario 3 (reassigned/absorbed): the bid's player identity survives
    // an account absorption, tracking the SAME real person, not the
    // now-deleted standalone player.
    // ---------------------------------------------------------------
    console.log("\nScenario 3: bid's player_id follows an account absorption");
    const player3 = await makeStandalonePlayer(db);
    const char3 = await makeCharacter(db, { playerId: player3, name: "VerifyBidderAbsorbed" });
    await grantEp(db, char3, player3, 2000);

    const result3 = await finalizeBidRound(
      db,
      { itemName: "Verify Test Item 3", entries: [{ characterName: "VerifyBidderAbsorbed", tier: "High Bid", occurredAt: new Date().toISOString(), isWinner: true }] },
      officerId,
    );
    check(failures, result3.ok, `finalizeBidRound succeeds (${!result3.ok ? result3.error : "ok"})`);

    const [rawBid3Before] = await db.select({ playerId: bids.playerId }).from(bids).where(eq(bids.characterId, char3));
    check(failures, rawBid3Before?.playerId === player3, "bid captured the standalone player before absorption");

    // A real member claims this character — attachCharacterToPlayer's
    // absorption path (players.ts) merges the defunct standalone player
    // into the claimant's real account and should move the bid with it.
    const claimantUserId = await makeUser(db);
    const [claimantPlayer] = await db
      .insert(players)
      .values({ userId: claimantUserId, discordId: `test-discord-${claimantUserId}`, displayName: "VerifyClaimant", role: "member", status: "active" })
      .returning({ id: players.id });
    const attachResult = await attachCharacterToPlayer(db, char3, claimantPlayer.id);
    check(failures, !attachResult.error, `attachCharacterToPlayer succeeds (${attachResult.error ?? "ok"})`);

    const [oldPlayerRow] = await db.select({ id: players.id }).from(players).where(eq(players.id, player3));
    check(failures, oldPlayerRow === undefined, "the defunct standalone player row was deleted by absorption");

    // absorbStandalonePlayer only marks the target dirty (Phase 4's own
    // eventual-consistency contract — a 2-minute repair pass or the next
    // explicit refresh materializes it, not attachCharacterToPlayer itself
    // synchronously). Refresh here to simulate that catching up, same as it
    // would in production before checking Current PR.
    await refreshStandings(db, { playerIds: [claimantPlayer.id] });

    const [rawBid3After] = await db.select({ playerId: bids.playerId }).from(bids).where(eq(bids.characterId, char3));
    check(failures, rawBid3After?.playerId === claimantPlayer.id, "the bid's player_id moved to the claimant's real account");

    const history3 = await listBidHistory(db, { q: "VerifyBidderAbsorbed" });
    const row3 = history3.rows.find((r) => r.characterName === "VerifyBidderAbsorbed");
    check(failures, row3 !== undefined, "bid history row found post-absorption");
    check(failures, row3?.currentPriority !== null, "Current PR still resolves after absorption (same real person, new account id)");

    // ---------------------------------------------------------------
    // Scenario 4 (backfill): a pre-Phase-7 row with no player_id of its own
    // infers it from the character's player_id — the migration's own
    // backfill statement, exercised directly rather than re-run wholesale.
    // ---------------------------------------------------------------
    console.log("\nScenario 4: backfilling a pre-existing NULL player_id row");
    const player4 = await makeStandalonePlayer(db);
    const char4 = await makeCharacter(db, { playerId: player4, name: "VerifyBidderBackfill" });
    await grantEp(db, char4, player4, 1500);
    const result4 = await finalizeBidRound(
      db,
      { itemName: "Verify Test Item 4", entries: [{ characterName: "VerifyBidderBackfill", tier: "High Bid", occurredAt: new Date().toISOString(), isWinner: true }] },
      officerId,
    );
    check(failures, result4.ok, `finalizeBidRound succeeds (${!result4.ok ? result4.error : "ok"})`);
    // Simulate a pre-migration row by clearing what the write path just set.
    await db.update(bids).set({ playerId: null }).where(eq(bids.characterId, char4));
    const [clearedBid4] = await db.select({ playerId: bids.playerId }).from(bids).where(eq(bids.characterId, char4));
    check(failures, clearedBid4?.playerId === null, "player_id cleared to simulate a pre-migration row");

    // Same statement migration 0038 runs — exercised directly against this
    // one synthetic row rather than re-applying the whole migration.
    await db.run(sql`
      UPDATE bids SET player_id = (SELECT player_id FROM characters WHERE characters.id = bids.character_id)
      WHERE player_id IS NULL AND character_id = ${char4}
    `);
    const [backfilledBid4] = await db.select({ playerId: bids.playerId }).from(bids).where(eq(bids.characterId, char4));
    check(failures, backfilledBid4?.playerId === player4, "backfill statement infers player_id from the character's current player_id");

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
  process.exit(1);
});
