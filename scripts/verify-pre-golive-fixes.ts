// 2026-09-29 pre-go-live fix batch — exercises, against local D1:
//   A) decay cutoff: "today" / a past evening are now included (was UTC-midnight)
//   B) per-cycle EP cap: attendance batch, manual entry, bypass, boundaries
//   C) deleting a winning GP row flips that bid back to lost
//
// Same technique as verify-bid-finalization.ts: real library entry points via
// getPlatformProxy, snapshot first and restored in a `finally`. Never point
// this at remote D1.
//
// Usage: npx tsx scripts/verify-pre-golive-fixes.ts
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import * as schema from "../src/db";
import { bids, characters, epLedger, gpLedger, lootEvents, players, users } from "../src/db";
import { planUnwinBidForGpRow } from "../src/lib/epgp/bid-unwin";
import { finalizeBidRound } from "../src/lib/epgp/bid-finalization";
import { previewRateDecay, resolveDecayCutoff } from "../src/lib/epgp/decay";
import { insertEpLedgerBatch, insertLedgerEntry } from "../src/lib/epgp/ledger-entry";
import { UNKNOWN_CLASS_ID, UNKNOWN_RACE_ID } from "../src/lib/eq/enums";
import { toGuildDateString } from "../src/lib/guild-timezone";

const SNAPSHOT_NAME = "pre-golive-fixes-verify";

type Db = ReturnType<typeof drizzle<typeof schema>>;

function check(failures: { n: number }, cond: boolean, msg: string) {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures.n++;
}

async function makeCharacter(db: Db, name: string) {
  const [player] = await db.insert(players).values({ displayName: name, role: "member", status: "active" }).returning({ id: players.id });
  const [char] = await db
    .insert(characters)
    .values({ name, class: UNKNOWN_CLASS_ID, race: UNKNOWN_RACE_ID, level: 1, playerId: player.id })
    .returning({ id: characters.id });
  await db.update(players).set({ mainCharacterId: char.id }).where(eq(players.id, player.id));
  return { characterId: char.id, playerId: player.id, name };
}

const uid = () => randomUUID().slice(0, 6);

async function main() {
  console.log(`Saving snapshot '${SNAPSHOT_NAME}'...`);
  execFileSync("scripts/snapshot.sh", ["save", SNAPSHOT_NAME], { stdio: "inherit" });

  const failures = { n: 0 };
  const proxy = await getPlatformProxy({ configPath: "wrangler.jsonc" });

  try {
    const db = drizzle(proxy.env.DATABASE as unknown as Parameters<typeof drizzle>[0], { schema });
    const officer = randomUUID();
    await db.insert(users).values({
      id: officer,
      email: `verify-golive-${officer}@example.invalid`,
      username: `VerifyGoLive-${officer.slice(0, 8)}`,
      role: "officer",
    });

    // -----------------------------------------------------------------
    // A) Decay cutoff
    // -----------------------------------------------------------------
    console.log("\nA) decay cutoff");
    const now = new Date();
    const today = toGuildDateString(now);
    const resToday = resolveDecayCutoff(today, now);
    check(failures, !("error" in resToday) && resToday.cutoff.getTime() === now.getTime(), "today's date resolves to 'now'");
    check(failures, !("error" in resToday) && resToday.effectiveDate.toISOString().startsWith(today), "effectiveDate stays the UTC-midnight label of the picked day");
    const tomorrow = toGuildDateString(new Date(now.getTime() + 36 * 3600_000));
    check(failures, "error" in resolveDecayCutoff(tomorrow, now), "a future date is rejected");
    check(failures, "error" in resolveDecayCutoff("not-a-date", now), "garbage is rejected");

    const decayToday = await makeCharacter(db, `VDecayToday${uid()}`);
    const decayPast = await makeCharacter(db, `VDecayPast${uid()}`);
    await insertLedgerEntry(db, { kind: "ep", characterId: decayToday.characterId, activity: "Verify", points: 100, occurredAt: new Date(now.getTime() - 60_000).toISOString(), note: "", bypassCap: true }, officer, "manual");
    // 9pm Eastern on 2026-09-27 = 2026-09-28T01:00Z — after the UTC-midnight that used to be the cutoff.
    await insertLedgerEntry(db, { kind: "ep", characterId: decayPast.characterId, activity: "Verify", points: 100, occurredAt: "2026-09-28T01:00:00Z", note: "", bypassCap: true }, officer, "manual");

    const newToday = resToday && !("error" in resToday) ? await previewRateDecay(db, 0.9, resToday.cutoff) : [];
    check(failures, newToday.find((r) => r.characterId === decayToday.characterId)?.epBalance === 100, "preview as of today includes an entry from a minute ago");
    if (!("error" in resToday)) {
      const oldToday = await previewRateDecay(db, 0.9, resToday.effectiveDate);
      check(failures, !oldToday.some((r) => r.characterId === decayToday.characterId), "(repro) the old UTC-midnight cutoff missed it");
    }
    const resPast = resolveDecayCutoff("2026-09-27", now);
    if (!("error" in resPast)) {
      const past = await previewRateDecay(db, 0.9, resPast.cutoff);
      check(failures, past.find((r) => r.characterId === decayPast.characterId)?.epBalance === 100, "a past date includes that whole Eastern evening");
      const pastOld = await previewRateDecay(db, 0.9, resPast.effectiveDate);
      check(failures, !pastOld.some((r) => r.characterId === decayPast.characterId), "(repro) the old cutoff dropped the 9pm ET entry");
      const dayBefore = resolveDecayCutoff("2026-09-26", now);
      if (!("error" in dayBefore)) {
        const before = await previewRateDecay(db, 0.9, dayBefore.cutoff);
        check(failures, !before.some((r) => r.characterId === decayPast.characterId), "the day before still excludes it");
      }
    } else {
      check(failures, false, `2026-09-27 should resolve (${resPast.error})`);
    }

    // -----------------------------------------------------------------
    // B) EP cycle cap (cycle 68 = 2026-09-13..2026-09-30, cycle 69 from 10-01)
    // -----------------------------------------------------------------
    console.log("\nB) EP cycle cap");
    const seed = (characterId: number, points: number, occurredAt: string) =>
      insertLedgerEntry(db, { kind: "ep", characterId, activity: "Verify Seed", points, occurredAt, note: "", bypassCap: true }, officer, "manual");
    const raidTime = "2026-09-20T23:00:00Z";
    const rowsFor = async (characterId: number) => (await db.select().from(epLedger).where(eq(epLedger.characterId, characterId))).sort((a, b) => a.id - b.id);

    const p1 = await makeCharacter(db, `VCap1${uid()}`);
    await seed(p1.characterId, 850, "2026-09-14T15:00:00Z");
    const r1 = await insertEpLedgerBatch(db, [{ characterId: p1.characterId, activity: "Raid - End", points: 50, occurredAt: raidTime, note: "", zone: null }], officer, "parse");
    check(failures, r1.inserted === 1 && r1.capped.length === 0, "850 + 50 = exactly the cap: awarded in full, not flagged");
    const r1b = await insertEpLedgerBatch(db, [{ characterId: p1.characterId, activity: "Raid - Start", points: 50, occurredAt: "2026-09-21T23:00:00Z", note: "", zone: null }], officer, "parse");
    const p1Rows = await rowsFor(p1.characterId);
    const p1Last = p1Rows.at(-1)!;
    check(failures, r1b.inserted === 1 && r1b.capped[0]?.awarded === 0 && r1b.capped[0]?.nominal === 50, "already capped: row still recorded, awarded 0 of 50");
    check(failures, p1Last.points === 0 && p1Last.pointsNominal === 50 && p1Last.capApplied === true, "row stores points 0 / nominal 50 / cap_applied");
    check(failures, /capped/i.test(p1Last.note ?? ""), `row note explains the cap ("${p1Last.note}")`);
    check(failures, p1Last.cycleId === 644, "row is stamped with cycle 68's id");

    const p2 = await makeCharacter(db, `VCap2${uid()}`);
    await seed(p2.characterId, 880, "2026-09-14T15:00:00Z");
    const r2 = await insertEpLedgerBatch(db, [{ characterId: p2.characterId, activity: "Raid - End", points: 50, occurredAt: raidTime, note: "hello", zone: null }], officer, "parse");
    const p2Last = (await rowsFor(p2.characterId)).at(-1)!;
    check(failures, r2.capped[0]?.awarded === 20 && p2Last.points === 20 && p2Last.pointsNominal === 50, "partial fit: only the remaining 20 recorded");
    check(failures, p2Last.note?.startsWith("hello — ") === true, "an existing note is kept and the cap note appended");

    // Manual entry path
    const m1 = await insertLedgerEntry(db, { kind: "ep", characterId: p1.characterId, activity: "Bank Donation", points: 100, occurredAt: "2026-09-22", note: "" }, officer, "manual");
    check(failures, m1.ok && m1.capped?.awarded === 0, "manual entry is capped too when already at the cap");
    const m2 = await insertLedgerEntry(db, { kind: "ep", characterId: p1.characterId, activity: "Bank Donation", points: 100, occurredAt: "2026-09-22", note: "", bypassCap: true }, officer, "manual");
    check(failures, m2.ok && !m2.capped && (await rowsFor(p1.characterId)).at(-1)!.points === 100, "bypassCap records the full amount");
    const m3 = await insertLedgerEntry(db, { kind: "ep", characterId: p1.characterId, activity: "Correction", points: -30, occurredAt: "2026-09-22", note: "" }, officer, "manual");
    check(failures, m3.ok && !m3.capped && (await rowsFor(p1.characterId)).at(-1)!.points === -30, "a negative correction is never clamped");

    // Boundaries
    const p3 = await makeCharacter(db, `VCap3${uid()}`);
    await seed(p3.characterId, 900, "2026-09-20T15:00:00Z");
    const r3 = await insertEpLedgerBatch(db, [{ characterId: p3.characterId, activity: "Raid - End", points: 50, occurredAt: "2026-10-01T01:00:00Z", note: "", zone: null }], officer, "parse");
    check(failures, r3.capped[0]?.awarded === 0, "9pm ET on 9/30 (already 10/01 in UTC) still belongs to cycle 68");
    const r3b = await insertEpLedgerBatch(db, [{ characterId: p3.characterId, activity: "Raid - End", points: 50, occurredAt: "2026-09-10T15:00:00Z", note: "", zone: null }], officer, "parse");
    const p3Rows = await rowsFor(p3.characterId);
    check(
      failures,
      r3b.capped.length === 0 && p3Rows.at(-1)!.points === 50,
      `an earlier cycle is counted separately: full 50 awarded (capped=${JSON.stringify(r3b.capped)}, rows=${JSON.stringify(p3Rows.map((r) => [r.points, r.occurredAt.toISOString(), r.cycleId]))})`,
    );

    // 9pm ET on 9/12 is already 9/13 in UTC — it belongs to cycle 67, not 68.
    const r3c = await insertEpLedgerBatch(db, [{ characterId: p3.characterId, activity: "Raid - Mid", points: 50, occurredAt: "2026-09-13T01:00:00Z", note: "", zone: null }], officer, "parse");
    check(failures, r3c.capped.length === 0 && (await rowsFor(p3.characterId)).at(-1)!.cycleId === 643, "9pm ET on 9/12 (9/13 in UTC) is cycle 67's, not 68's");

    const p4 = await makeCharacter(db, `VCap4${uid()}`);
    await seed(p4.characterId, 900, "2026-09-30"); // website date-input entry: UTC-midnight bucket on the last day
    const r4 = await insertEpLedgerBatch(db, [{ characterId: p4.characterId, activity: "Raid - End", points: 50, occurredAt: "2026-09-25T23:00:00Z", note: "", zone: null }], officer, "parse");
    check(failures, r4.capped[0]?.awarded === 0, "a UTC-midnight entry dated on the cycle's last day counts toward it");

    // -----------------------------------------------------------------
    // C) Deleting a winning GP row flips the bid to lost
    // -----------------------------------------------------------------
    console.log("\nC) unwinding a deleted win");
    const w1 = await makeCharacter(db, `VWin1${uid()}`);
    const w2 = await makeCharacter(db, `VWin2${uid()}`);
    const l1 = await makeCharacter(db, `VLose${uid()}`);
    const item = `Verify Soul Essence ${uid()}`;
    const at = new Date().toISOString();
    const fin = await finalizeBidRound(
      db,
      {
        itemName: item,
        entries: [
          { characterName: w1.name, tier: "High Bid", occurredAt: at, isWinner: true },
          { characterName: w2.name, tier: "High Bid", occurredAt: at, isWinner: true },
          { characterName: l1.name, tier: "High Bid", occurredAt: at, isWinner: false },
        ],
        submissionId: randomUUID(),
      },
      officer,
    );
    if (!fin.ok) throw new Error(`finalize failed: ${fin.error}`);
    const gpRows = await db.select().from(gpLedger).where(eq(gpLedger.lootEventId, fin.lootEventId));
    check(failures, gpRows.length === 2, "winner GP rows carry the loot event id");

    const bidStatus = async (characterId: number) => (await db.select().from(bids).where(eq(bids.lootEventId, fin.lootEventId))).find((b) => b.characterId === characterId)?.status;
    const w2Gp = gpRows.find((g) => g.characterId === w2.characterId)!;
    const unwind = await planUnwinBidForGpRow(db, w2Gp);
    check(failures, unwind.length === 2, "a bid-win GP row plans an unwind");
    await db.batch([db.delete(gpLedger).where(eq(gpLedger.id, w2Gp.id)), ...unwind] as [(typeof unwind)[number], ...(typeof unwind)[number][]]);
    check(failures, (await bidStatus(w2.characterId)) === "lost", "the deleted winner's bid is now lost");
    check(failures, (await bidStatus(w1.characterId)) === "won", "the other winner is untouched");

    // Deleting the pointed-at winner repoints winning_bid_id.
    const w1Gp = (await db.select().from(gpLedger).where(eq(gpLedger.lootEventId, fin.lootEventId)))[0];
    const [evBefore] = await db.select().from(lootEvents).where(eq(lootEvents.id, fin.lootEventId));
    check(failures, evBefore.winningBidId != null, "winning_bid_id set before the last delete");
    const unwind2 = await planUnwinBidForGpRow(db, w1Gp);
    await db.batch([db.delete(gpLedger).where(eq(gpLedger.id, w1Gp.id)), ...unwind2] as [(typeof unwind2)[number], ...(typeof unwind2)[number][]]);
    const [evAfter] = await db.select().from(lootEvents).where(eq(lootEvents.id, fin.lootEventId));
    check(failures, evAfter.winningBidId === null && (await bidStatus(w1.characterId)) === "lost", "no winners left: winning_bid_id cleared");

    // Legacy row with no loot_event_id: falls back to item + time.
    const w3 = await makeCharacter(db, `VWin3${uid()}`);
    const item3 = `Verify Legacy ${uid()}`;
    const fin3 = await finalizeBidRound(db, { itemName: item3, entries: [{ characterName: w3.name, tier: "High Bid", occurredAt: at, isWinner: true }], submissionId: randomUUID() }, officer);
    if (!fin3.ok) throw new Error(`finalize failed: ${fin3.error}`);
    await db.update(gpLedger).set({ lootEventId: null }).where(eq(gpLedger.characterId, w3.characterId));
    const legacyGp = (await db.select().from(gpLedger).where(eq(gpLedger.characterId, w3.characterId)))[0];
    const unwind3 = await planUnwinBidForGpRow(db, legacyGp);
    check(failures, unwind3.length === 2, "a pre-0054 row (no loot_event_id) is still matched by item name + time");

    // A manual GP adjustment is not a bid win.
    const manual = await insertLedgerEntry(db, { kind: "gp", characterId: w3.characterId, tier: "Correction", itemName: "", points: 25, occurredAt: "2026-09-22", note: "" }, officer, "manual");
    const manualGp = (await db.select().from(gpLedger).where(eq(gpLedger.tier, "Correction"))).find((g) => g.characterId === w3.characterId);
    check(failures, manual.ok && manualGp !== undefined && (await planUnwinBidForGpRow(db, manualGp)).length === 0, "a manual GP entry plans no unwind");

    console.log(failures.n === 0 ? "\nAll checks passed." : `\n${failures.n} check(s) FAILED.`);
  } finally {
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
