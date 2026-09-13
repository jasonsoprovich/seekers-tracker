// Phase 10.2: exercise the real raid/decay reversal entry points against
// local D1. A snapshot is restored in finally; never point this at remote D1.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import * as schema from "../src/db";
import { bids, characters, decayEvents, epLedger, gpLedger, ledgerAuditLog, lootEvents, players, users } from "../src/db";
import { reverseDecayEvent } from "../src/lib/epgp/decay";
import { UNKNOWN_CLASS_ID, UNKNOWN_RACE_ID } from "../src/lib/eq/enums";
import { reverseRaid } from "../src/lib/epgp/raids";

const SNAPSHOT = "phase10-reversal-test";
type Db = ReturnType<typeof drizzle<typeof schema>>;

function check(failures: { n: number }, condition: boolean, message: string) {
  console.log(`  ${condition ? "ok  " : "FAIL"} ${message}`);
  if (!condition) failures.n++;
}

async function fixture(db: Db) {
  const suffix = randomUUID();
  const userId = `verify-reversal-${suffix}`;
  await db.insert(users).values({
    id: userId,
    email: `${userId}@example.invalid`,
    username: userId,
    discordId: userId,
    role: "leader",
  });
  const [player] = await db.insert(players).values({ userId, displayName: userId, role: "leader" }).returning({ id: players.id });
  const [character] = await db
    .insert(characters)
    .values({ name: `Verify${suffix.slice(0, 8)}`, class: UNKNOWN_CLASS_ID, race: UNKNOWN_RACE_ID, level: 1, charType: "main", playerId: player.id })
    .returning({ id: characters.id });
  await db.update(players).set({ mainCharacterId: character.id }).where(eq(players.id, player.id));
  return { userId, playerId: player.id, characterId: character.id };
}

async function addDecay(db: Db, ids: Awaited<ReturnType<typeof fixture>>, effectiveDate: Date) {
  const [event] = await db
    .insert(decayEvents)
    .values({ kind: "expansion", epRate: 0.5, gpRate: 0.5, effectiveDate, label: "Phase 10 reversal test", appliedBy: ids.userId })
    .returning({ id: decayEvents.id });
  const [ep] = await db
    .insert(epLedger)
    .values({ characterId: ids.characterId, playerId: ids.playerId, occurredAt: effectiveDate, activity: "Decay", points: -50, pointsNominal: -50, pointsAwarded: -50, note: "test", enteredBy: ids.userId, decayEventId: event.id })
    .returning({ id: epLedger.id });
  const [gp] = await db
    .insert(gpLedger)
    .values({ characterId: ids.characterId, playerId: ids.playerId, occurredAt: effectiveDate, itemName: "Test item", tier: "Decay", points: -25, pointsNominal: -25, pointsAwarded: -25, note: "test", enteredBy: ids.userId, decayEventId: event.id })
    .returning({ id: gpLedger.id });
  return { eventId: event.id, epId: ep.id, gpId: gp.id };
}

async function main() {
  execFileSync("scripts/snapshot.sh", ["save", SNAPSHOT], { stdio: "inherit" });
  const proxy = await getPlatformProxy({ configPath: "wrangler.jsonc" });
  const db = drizzle(proxy.env.DATABASE as unknown as Parameters<typeof drizzle>[0], { schema });
  const failures = { n: 0 };

  try {
    const ids = await fixture(db);

    console.log("Decay reversal transaction");
    const decay = await addDecay(db, ids, new Date("2037-01-14T12:00:00Z"));
    const outcome = await reverseDecayEvent(db, decay.eventId, ids.userId);
    check(failures, "ok" in outcome && outcome.epRows === 1 && outcome.gpRows === 1, "reverses and reports both ledger rows");
    const [remainingDecayRows, event, audits] = await Promise.all([
      Promise.all([
        db.select().from(epLedger).where(eq(epLedger.id, decay.epId)),
        db.select().from(gpLedger).where(eq(gpLedger.id, decay.gpId)),
      ]),
      db.select().from(decayEvents).where(eq(decayEvents.id, decay.eventId)),
      db.select().from(ledgerAuditLog).where(and(eq(ledgerAuditLog.changedBy, ids.userId), inArray(ledgerAuditLog.ledgerId, [decay.epId, decay.gpId]))),
    ]);
    check(failures, remainingDecayRows.every((rows) => rows.length === 0), "deletes both authoritative rows");
    check(failures, Boolean(event[0]?.reversedAt), "marks the event reversed in the same batch");
    check(failures, audits.length === 2 && audits.every((row) => row.action === "delete"), "writes one durable delete audit per row");
    const epBefore = audits.find((row) => row.ledgerType === "ep")?.before as Record<string, unknown> | undefined;
    check(failures, epBefore?.activity === "Decay" && epBefore.capApplied === false && typeof epBefore.occurredAt === "string", "preserves typed, camelCase audit fields");
    const duplicate = await reverseDecayEvent(db, decay.eventId, ids.userId);
    check(failures, "error" in duplicate && /already reversed/.test(duplicate.error), "a retry is an idempotent conflict");

    console.log("Decay rollback on audit failure");
    const failedDecay = await addDecay(db, ids, new Date("2037-01-14T13:00:00Z"));
    let decayFailed = false;
    try {
      await reverseDecayEvent(db, failedDecay.eventId, "missing-user");
    } catch {
      decayFailed = true;
    }
    const [failedEp, failedGp, activeEvent] = await Promise.all([
      db.select().from(epLedger).where(eq(epLedger.id, failedDecay.epId)),
      db.select().from(gpLedger).where(eq(gpLedger.id, failedDecay.gpId)),
      db.select().from(decayEvents).where(eq(decayEvents.id, failedDecay.eventId)),
    ]);
    check(failures, decayFailed, "surfaces the transaction failure");
    check(failures, failedEp.length === 1 && failedGp.length === 1 && !activeEvent[0]?.reversedAt, "rolls back every authoritative decay change");

    console.log("Raid reversal transaction");
    const occurredAt = new Date("2037-01-15T02:00:00Z");
    const [raidEp] = await db.insert(epLedger).values({ characterId: ids.characterId, playerId: ids.playerId, occurredAt, activity: "Raid - End", points: 50, enteredBy: ids.userId, source: "parse" }).returning({ id: epLedger.id });
    const [raidGp] = await db.insert(gpLedger).values({ characterId: ids.characterId, playerId: ids.playerId, occurredAt, itemName: "Raid item", tier: "High Bid", points: 50, enteredBy: ids.userId, source: "parse" }).returning({ id: gpLedger.id });
    const [loot] = await db.insert(lootEvents).values({ occurredAt, itemName: "Raid item", status: "awarded", openedBy: ids.userId }).returning({ id: lootEvents.id });
    const [bid] = await db.insert(bids).values({ lootEventId: loot.id, characterId: ids.characterId, playerId: ids.playerId, tier: "High Bid", status: "won" }).returning({ id: bids.id });
    await db.update(lootEvents).set({ winningBidId: bid.id }).where(eq(lootEvents.id, loot.id));
    const raidOutcome = await reverseRaid(db, "2037-01-14", ids.userId);
    check(failures, "ok" in raidOutcome && raidOutcome.epRows === 1 && raidOutcome.gpRows === 1 && raidOutcome.lootEvents === 1 && raidOutcome.bids === 1, "reverses the guild-local raid as one unit");
    const [raidEpAfter, raidGpAfter, lootAfter, bidAfter] = await Promise.all([
      db.select().from(epLedger).where(eq(epLedger.id, raidEp.id)),
      db.select().from(gpLedger).where(eq(gpLedger.id, raidGp.id)),
      db.select().from(lootEvents).where(eq(lootEvents.id, loot.id)),
      db.select().from(bids).where(eq(bids.id, bid.id)),
    ]);
    check(failures, raidEpAfter.length + raidGpAfter.length + lootAfter.length + bidAfter.length === 0, "deletes attendance, GP, loot, and bids together");

    console.log("Raid rollback on audit failure");
    const failedAt = new Date("2037-01-16T02:00:00Z");
    const [rollbackEp] = await db.insert(epLedger).values({ characterId: ids.characterId, playerId: ids.playerId, occurredAt: failedAt, activity: "Raid - End", points: 50, enteredBy: ids.userId, source: "parse" }).returning({ id: epLedger.id });
    let raidFailed = false;
    try {
      await reverseRaid(db, "2037-01-15", "missing-user");
    } catch {
      raidFailed = true;
    }
    const rollbackEpAfter = await db.select().from(epLedger).where(eq(epLedger.id, rollbackEp.id));
    check(failures, raidFailed && rollbackEpAfter.length === 1, "rolls back the raid when its audit insert fails");

    if (failures.n > 0) throw new Error(`${failures.n} reversal check(s) failed`);
    console.log("All reversal checks passed.");
  } finally {
    await proxy.dispose();
    execFileSync("scripts/snapshot.sh", ["restore", SNAPSHOT], { stdio: "inherit" });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
