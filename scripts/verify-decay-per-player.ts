// Regression test for the 2026-09-29 expansion-decay bug: decay was taken per
// CHARACTER while standings are totalled per PLAYER. After a main/alt swap a
// player can have one character holding the earned EP (+X) and the old main
// holding only earlier decay rows (-Y); decaying X and skipping Y left
// rate*X - Y instead of rate*(X - Y) — Korrek/Blesko/Youmadin/Tunedup ended
// near zero or negative.
//
// Finds every player in the local DB whose characters have mixed-sign EP
// balances, then runs the REAL previewRateDecay/commitRateDecay and
// previewDepartureWipe/commitDepartureWipe and asserts the player's summed
// ledger lands exactly where decay-on-the-net says it should. Snapshots first
// and restores in a `finally` (same as verify-global-decay.ts) — never point
// it at remote D1.
//
// Usage: npm run verify:decay-per-player
import { execFileSync } from "node:child_process";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import * as schema from "../src/db";
import { epLedger, gpLedger, users } from "../src/db/schema";
import { commitDepartureWipe, commitRateDecay, previewDepartureWipe, previewRateDecay } from "../src/lib/epgp/decay";

// commitRateDecay's standings refresh touches the Workers Cache API, absent
// under plain tsx — same stand-in verify-global-decay.ts uses.
if (typeof (globalThis as Record<string, unknown>).caches === "undefined") {
  (globalThis as unknown as { caches: unknown }).caches = {
    default: { match: async () => undefined, put: async () => {}, delete: async () => true },
  };
}

const SNAPSHOT_NAME = "decay-per-player-test";
const RATE = 0.9;
const EFFECTIVE = new Date("2030-01-01T00:00:00Z");

type Db = ReturnType<typeof drizzle>;

async function playerSums(db: Db, ledger: typeof epLedger | typeof gpLedger): Promise<Map<number, number>> {
  const rows = await db
    .select({ playerId: ledger.playerId, sum: sql<number>`coalesce(sum(${ledger.points}), 0)` })
    .from(ledger)
    .where(sql`${ledger.playerId} is not null and ${ledger.characterId} is not null`)
    .groupBy(ledger.playerId);
  return new Map(rows.map((r) => [r.playerId as number, r.sum]));
}

async function main() {
  console.log(`Saving snapshot '${SNAPSHOT_NAME}'...`);
  execFileSync("scripts/snapshot.sh", ["save", SNAPSHOT_NAME], { stdio: "inherit" });

  let failures = 0;
  const check = (ok: boolean, msg: string) => {
    console.log(`  ${ok ? "PASS" : "FAIL"} ${msg}`);
    if (!ok) failures++;
  };
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.02;

  const proxy = await getPlatformProxy({ configPath: "wrangler.jsonc" });
  try {
    const db = drizzle(proxy.env.DATABASE as unknown as Parameters<typeof drizzle>[0], { schema });
    const [anyUser] = await db.select({ id: users.id }).from(users).limit(1);
    if (!anyUser) throw new Error("No users row in local D1 — decay_events.applied_by needs a real user id.");

    // Players with a positive and a negative character balance (the post-swap shape).
    const mixed = await db.all<{ player_id: number; pos_char: number; neg_char: number }>(sql`
      SELECT player_id, max(CASE WHEN b > 0 THEN character_id END) AS pos_char, max(CASE WHEN b < 0 THEN character_id END) AS neg_char
      FROM (SELECT player_id, character_id, sum(points) AS b FROM ep_ledger
            WHERE player_id IS NOT NULL AND character_id IS NOT NULL GROUP BY player_id, character_id)
      GROUP BY player_id HAVING sum(b > 0) > 0 AND sum(b < 0) > 0 AND sum(b) > 0`);
    if (mixed.length === 0) {
      console.error("No mixed-sign players in local D1 — nothing to test against.");
      process.exit(1);
    }
    console.log(`Found ${mixed.length} player(s) with a positive + negative character balance.`);

    const epBefore = await playerSums(db, epLedger);
    const gpBefore = await playerSums(db, gpLedger);

    // 1. Preview: exactly one row per mixed player, decay taken on the NET.
    const preview = await previewRateDecay(db, RATE, EFFECTIVE);
    for (const m of mixed) {
      const rows = preview.filter((r) => r.playerId === m.player_id);
      const net = epBefore.get(m.player_id) ?? 0;
      check(rows.length === 1, `player ${m.player_id}: one preview row (got ${rows.length})`);
      if (rows.length === 1) {
        check(near(rows[0].epBalance, net), `player ${m.player_id}: previewed EP balance ${rows[0].epBalance.toFixed(2)} == net ${net.toFixed(2)}`);
        check(near(rows[0].epDecay, net * RATE), `player ${m.player_id}: EP decay ${rows[0].epDecay.toFixed(2)} == ${(net * RATE).toFixed(2)}`);
      }
    }

    // 2. Commit: every player's summed ledger ends at (1 - rate) * net.
    const result = await commitRateDecay(db, { kind: "expansion", rate: RATE, effectiveDate: EFFECTIVE, appliedBy: anyUser.id, label: "per-player decay test" });
    if ("error" in result) throw new Error(`commitRateDecay failed: ${result.error}`);
    const epAfter = await playerSums(db, epLedger);
    const gpAfter = await playerSums(db, gpLedger);
    for (const m of mixed) {
      const net = epBefore.get(m.player_id) ?? 0;
      const got = epAfter.get(m.player_id) ?? 0;
      check(near(got, net * (1 - RATE)), `player ${m.player_id}: EP after decay ${got.toFixed(2)} == ${(net * (1 - RATE)).toFixed(2)} (was ${net.toFixed(2)})`);
      const gpNet = gpBefore.get(m.player_id) ?? 0;
      if (gpNet > 0) {
        const gpGot = gpAfter.get(m.player_id) ?? 0;
        check(near(gpGot, gpNet * (1 - RATE)), `player ${m.player_id}: GP after decay ${gpGot.toFixed(2)} == ${(gpNet * (1 - RATE)).toFixed(2)}`);
      }
    }

    // 3. Departure wipe selecting ONLY the positive character: the whole
    // account's EP must still land on exactly 0, not -Y.
    const subject = mixed[0];
    const wipePreview = await previewDepartureWipe(db, { characterIds: [subject.pos_char] });
    check(wipePreview.length === 1, `departure preview: one row for player ${subject.player_id} (got ${wipePreview.length})`);
    const wipe = await commitDepartureWipe(db, { characterIds: [subject.pos_char], appliedBy: anyUser.id, label: "per-player wipe test" });
    if ("error" in wipe) throw new Error(`commitDepartureWipe failed: ${wipe.error}`);
    const epWiped = await playerSums(db, epLedger);
    check(near(epWiped.get(subject.player_id) ?? NaN, 0), `player ${subject.player_id}: EP after departure wipe ${(epWiped.get(subject.player_id) ?? NaN).toFixed(2)} == 0`);
    const gpWiped = await playerSums(db, gpLedger);
    check(near(gpWiped.get(subject.player_id) ?? 0, gpAfter.get(subject.player_id) ?? 0), `player ${subject.player_id}: GP untouched by the wipe`);
  } catch (err) {
    console.error(err);
    failures++;
  } finally {
    await proxy.dispose();
    console.log(`Restoring snapshot '${SNAPSHOT_NAME}'...`);
    execFileSync("scripts/snapshot.sh", ["restore", SNAPSHOT_NAME], { stdio: "inherit" });
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
