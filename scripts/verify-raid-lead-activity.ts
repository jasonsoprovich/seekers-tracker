import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import * as schema from "../src/db";
import { bids, characters, epLedger, epgpPointValues, gpLedger, lootEvents, players, standingsDirty, users } from "../src/db";
import { getOwnedAccountActivitySummaries } from "../src/lib/epgp/account-activity";
import { insertPreparedEventLeadAward, prepareEventLeadAward } from "../src/lib/epgp/attendance";
import { insertLedgerEntry } from "../src/lib/epgp/ledger-entry";
import { getRaidDetail, listRaids, reverseRaid, setRaidLeader } from "../src/lib/epgp/raids";
import { UNKNOWN_CLASS_ID, UNKNOWN_RACE_ID } from "../src/lib/eq/enums";
import { toGuildDateString } from "../src/lib/guild-timezone";

const SNAPSHOT = "raid-lead-activity-test";
type Db = ReturnType<typeof drizzle<typeof schema>>;

function check(failures: { n: number }, condition: boolean, message: string) {
  console.log(`  ${condition ? "ok  " : "FAIL"} ${message}`);
  if (!condition) failures.n++;
}

async function addAccount(db: Db, userId: string, username: string) {
  await db.insert(users).values({
    id: userId,
    email: `${userId}@example.invalid`,
    username,
    discordId: userId,
    role: "officer",
  });
  const [player] = await db.insert(players).values({ userId, displayName: username, role: "officer" }).returning({ id: players.id });
  const [main] = await db
    .insert(characters)
    .values({
      name: `Verify${randomUUID().slice(0, 8)}`,
      class: UNKNOWN_CLASS_ID,
      race: UNKNOWN_RACE_ID,
      level: 1,
      charType: "main",
      ownerId: userId,
      playerId: player.id,
    })
    .returning({ id: characters.id, name: characters.name });
  await db.update(players).set({ mainCharacterId: main.id }).where(eq(players.id, player.id));
  return { userId, playerId: player.id, characterId: main.id, mainName: main.name };
}

async function main() {
  execFileSync("scripts/snapshot.sh", ["save", SNAPSHOT], { stdio: "inherit" });
  const proxy = await getPlatformProxy({ configPath: "wrangler.jsonc" });
  const db = drizzle(proxy.env.DATABASE as unknown as Parameters<typeof drizzle>[0], { schema });
  const failures = { n: 0 };

  try {
    const lead = await addAccount(db, `verify-raid-lead-${randomUUID()}`, "Fallback Leader");
    const other = await addAccount(db, `verify-raid-other-${randomUUID()}`, "Other Officer");
    const corrected = await addAccount(db, `verify-raid-correction-${randomUUID()}`, "Correction Officer");
    const occurredAt = new Date("2037-01-15T02:00:00Z");

    console.log("Event Lead validation and idempotency");
    const ineligible = await prepareEventLeadAward(db, lead.userId, "Guild Meeting", occurredAt);
    check(failures, !ineligible.ok, "rejects Event Lead on a non-attendance activity");
    const prepared = await prepareEventLeadAward(db, lead.userId, "Raid - End", occurredAt);
    check(failures, prepared.ok && prepared.award.points === 10, "resolves the configured Event Lead value and API-key owner's main");
    if (!prepared.ok) throw new Error(prepared.error);

    const attempts = await Promise.all([
      insertPreparedEventLeadAward(db, prepared.award, occurredAt, lead.userId, "verification"),
      insertPreparedEventLeadAward(db, prepared.award, occurredAt, lead.userId, "verification"),
    ]);
    const leadRows = await db.select().from(epLedger).where(eq(epLedger.sourceKey, prepared.award.sourceKey));
    check(failures, attempts.filter(Boolean).length === 1 && leadRows.length === 1, "concurrent retries insert exactly one parse-sourced Event Lead row");
    const dirty = await db.select().from(standingsDirty).where(eq(standingsDirty.scope, `player:${lead.playerId}`));
    check(failures, dirty.length === 1, "the unique award transaction leaves a standings dirty marker");

    // Officer-chosen Event Lead recipient (2026-09-22): the officer taking
    // attendance isn't always the actual raid leader. A separate day
    // (2037-01-16, vs. the shared 2037-01-14 fixture the rest of this
    // script's raid-aggregation checks depend on below) so an actual
    // insert here can't perturb their EP/row-count assertions.
    const overrideOccurredAt = new Date("2037-01-16T02:00:00Z");
    const overridden = await prepareEventLeadAward(db, lead.userId, "Raid - End", overrideOccurredAt, other.mainName);
    check(
      failures,
      overridden.ok && overridden.award.playerId === other.playerId && overridden.award.characterName === other.mainName,
      "an override name awards the NAMED character's player/main, not the submitting officer's",
    );
    check(
      failures,
      overridden.ok && overridden.award.sourceKey !== prepared.award.sourceKey,
      "the override's award has a different source key than the default-recipient award for the same moment",
    );
    const caseInsensitive = await prepareEventLeadAward(db, lead.userId, "Raid - End", overrideOccurredAt, other.mainName.toUpperCase());
    check(failures, caseInsensitive.ok && caseInsensitive.award.playerId === other.playerId, "the override name resolves case-insensitively");
    const unknownName = await prepareEventLeadAward(db, lead.userId, "Raid - End", overrideOccurredAt, "NoSuchCharacterAtAll");
    check(failures, !unknownName.ok, "rejects an override name that doesn't match any character");
    const noMainYet = await addAccount(db, `verify-raid-no-main-${randomUUID()}`, "No Main Yet");
    await db.update(players).set({ mainCharacterId: null }).where(eq(players.id, noMainYet.playerId));
    const noMain = await prepareEventLeadAward(db, lead.userId, "Raid - End", overrideOccurredAt, noMainYet.mainName);
    check(failures, !noMain.ok, "rejects an override name whose player has no current main set");
    if (overridden.ok) {
      const inserted = await insertPreparedEventLeadAward(db, overridden.award, overrideOccurredAt, lead.userId, "verification");
      const overriddenRows = await db.select().from(epLedger).where(eq(epLedger.sourceKey, overridden.award.sourceKey));
      check(
        failures,
        inserted && overriddenRows.length === 1 && overriddenRows[0]?.playerId === other.playerId,
        "the override award actually lands on the named character's player, not the officer's own",
      );
    }

    const createdFirst = new Date("2037-01-15T02:01:00Z");
    const createdSecond = new Date("2037-01-15T02:02:00Z");
    await db.insert(epLedger).values([
      {
        characterId: lead.characterId,
        playerId: lead.playerId,
        occurredAt,
        activity: "Raid - End",
        points: 50,
        enteredBy: lead.userId,
        source: "parse",
        createdAt: createdFirst,
      },
      {
        characterId: other.characterId,
        playerId: other.playerId,
        occurredAt,
        activity: "Raid - End",
        points: 50,
        enteredBy: other.userId,
        source: "parse",
        createdAt: createdSecond,
      },
    ]);

    const [newMain] = await db
      .insert(characters)
      .values({
        name: `Verify${randomUUID().slice(0, 8)}`,
        class: UNKNOWN_CLASS_ID,
        race: UNKNOWN_RACE_ID,
        level: 1,
        charType: "main",
        ownerId: lead.userId,
        playerId: lead.playerId,
      })
      .returning({ id: characters.id, name: characters.name });
    await db.update(players).set({ mainCharacterId: newMain.id }).where(eq(players.id, lead.playerId));

    await db.insert(epLedger).values({
      characterId: corrected.characterId,
      playerId: corrected.playerId,
      occurredAt: new Date("2037-01-16T02:00:00Z"),
      activity: "Raid - End",
      points: 50,
      note: "missed parse",
      enteredBy: corrected.userId,
      source: "manual",
      raidDate: "2037-01-14",
    });
    await db.insert(gpLedger).values({
      characterId: corrected.characterId,
      playerId: corrected.playerId,
      occurredAt: new Date("2037-01-16T02:00:00Z"),
      itemName: "Rotten Example Item",
      tier: "Rot (No-Drop)",
      points: 10,
      note: "missed bid window",
      enteredBy: corrected.userId,
      source: "manual",
      raidDate: "2037-01-14",
    });
    const [duplicateDrop] = await db.insert(lootEvents).values({ occurredAt, itemName: "Duplicated Example Item", status: "awarded", openedBy: lead.userId }).returning();
    const winningBids = await db.insert(bids).values([
      { lootEventId: duplicateDrop.id, characterId: lead.characterId, playerId: lead.playerId, tier: "High Bid", status: "won" },
      { lootEventId: duplicateDrop.id, characterId: other.characterId, playerId: other.playerId, tier: "High Bid", status: "won" },
    ]).returning();
    await db.update(lootEvents).set({ winningBidId: winningBids[0].id }).where(eq(lootEvents.id, duplicateDrop.id));
    await db.insert(gpLedger).values([
      { characterId: lead.characterId, playerId: lead.playerId, occurredAt, itemName: duplicateDrop.itemName, tier: "High Bid", points: 10, enteredBy: lead.userId, source: "parse" },
      { characterId: other.characterId, playerId: other.playerId, occurredAt, itemName: duplicateDrop.itemName, tier: "High Bid", points: 10, enteredBy: lead.userId, source: "parse" },
    ]);

    const currentDate = toGuildDateString(new Date());
    const linkedCorrection = await insertLedgerEntry(
      db,
      {
        kind: "ep",
        characterId: corrected.characterId,
        activity: "Raid - End",
        points: 50,
        occurredAt: new Date().toISOString(),
        note: "validation check",
        raidDate: currentDate,
      },
      corrected.userId,
    );
    const invalidLink = await insertLedgerEntry(
      db,
      {
        kind: "ep",
        characterId: corrected.characterId,
        activity: "Guild Meeting",
        points: 5,
        occurredAt: new Date().toISOString(),
        note: "",
        raidDate: currentDate,
      },
      corrected.userId,
    );

    console.log("Raid aggregation");
    const [level65] = await db
      .select({ points: epgpPointValues.points, retired: epgpPointValues.retired })
      .from(epgpPointValues)
      .where(and(eq(epgpPointValues.kind, "ep"), eq(epgpPointValues.activity, "Hitting lvl 65")));
    const detail = await getRaidDetail(db, "2037-01-14");
    check(failures, detail?.leader === newMain.name, "displays the first attendance submitter using their current main");
    check(failures, level65?.points === 100 && !level65.retired, "makes the active Hitting lvl 65 activity worth 100 EP");
    check(
      failures,
      linkedCorrection.ok && !invalidLink.ok,
      `accepts an attendance correction link and rejects non-attendance links (${linkedCorrection.ok ? "linked" : linkedCorrection.error}; ${invalidLink.ok ? "invalid accepted" : invalidLink.error})`,
    );
    check(failures, detail?.memberCount === 3 && detail.captures.length === 1 && detail.captures[0]?.members.length === 3, "combines linked manual corrections with the event attendance");
    check(failures, detail?.classAttendance.find((entry) => entry.classId === UNKNOWN_CLASS_ID)?.count === 3, "summarizes distinct attendees by class");
    check(failures, detail?.epAwarded === 160, "includes linked manual attendance in raid EP awarded");
    check(failures, detail?.gpSpent === 30 && detail.loot.some((loot) => loot.itemName === "Rotten Example Item" && loot.winners[0]?.note?.startsWith("Rot loot")), "includes linked manual rot loot in event GP and loot history");
    check(failures, detail?.loot.find((loot) => loot.itemName === duplicateDrop.itemName)?.winners.length === 2, "shows every winner of a duplicate drop with their GP charge");
    const listed = (await listRaids(db)).find((raid) => raid.raidDate === "2037-01-14");
    check(failures, listed?.leader === newMain.name && listed.memberCount === 3 && listed.epAwarded === 160 && listed.gpSpent === 30 && listed.itemCount === 2, "raid list includes linked manual attendance and rot loot without changing the parsed raid leader");

    await db.insert(epLedger).values([
      { characterId: lead.characterId, playerId: lead.playerId, occurredAt, activity: "Raid - Start", points: 50, enteredBy: lead.userId, source: "parse", raidName: "North" },
      { characterId: other.characterId, playerId: other.playerId, occurredAt, activity: "Raid - Start", points: 50, enteredBy: other.userId, source: "parse", raidName: "South" },
    ]);
    const sameDay = (await listRaids(db)).filter((raid) => raid.raidDate === "2037-01-14");
    const north = await getRaidDetail(db, "2037-01-14", "North");
    const south = await getRaidDetail(db, "2037-01-14", "South");
    check(failures, sameDay.length === 3 && north?.memberCount === 1 && north.epAwarded === 50 && south?.memberCount === 1 && south.epAwarded === 50, "keeps named same-day events distinct from each other and the historical unnamed event");

    await setRaidLeader(db, "2037-01-14", other.playerId, corrected.userId);
    const correctedLeader = await getRaidDetail(db, "2037-01-14");
    const correctedLeadAward = await db.select().from(epLedger).where(eq(epLedger.sourceKey, prepared.award.sourceKey));
    check(failures, correctedLeader?.leader === other.mainName && correctedLeadAward[0]?.playerId === other.playerId, "corrects the displayed event leader and transfers Event Lead EP");

    const reversed = await reverseRaid(db, "2037-01-14", lead.userId);
    const leadAfterReverse = await db.select().from(epLedger).where(eq(epLedger.sourceKey, prepared.award.sourceKey));
    const correctionAfterReverse = await db.select().from(epLedger).where(eq(epLedger.raidDate, "2037-01-14"));
    const rotAfterReverse = await db.select().from(gpLedger).where(eq(gpLedger.raidDate, "2037-01-14"));
    check(failures, "ok" in reversed && reversed.epRows === 5 && leadAfterReverse.length === 0 && correctionAfterReverse.length === 1 && rotAfterReverse.length === 1, "raid reversal removes every same-date parsed event but preserves linked manual corrections and rot loot");

    console.log("Owned-account activity summaries");
    const secondPlayer = await db.insert(players).values({ userId: lead.userId, displayName: "Second owned account" }).returning({ id: players.id });
    const now = new Date("2026-09-15T12:00:00Z");
    await db.insert(epLedger).values([
      { characterId: newMain.id, playerId: lead.playerId, occurredAt: new Date(now.getTime() - 60 * 60 * 1000), activity: "Recent", points: 20 },
      { characterId: newMain.id, playerId: lead.playerId, occurredAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000), activity: "Older", points: 30 },
      { characterId: newMain.id, playerId: lead.playerId, occurredAt: now, activity: "Decay", points: -100 },
      { playerId: secondPlayer[0].id, occurredAt: now, activity: "Second", points: 11 },
    ]);
    await db.insert(gpLedger).values([
      { characterId: newMain.id, playerId: lead.playerId, occurredAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000), tier: "Recent", points: 5 },
      { characterId: newMain.id, playerId: lead.playerId, occurredAt: new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000), tier: "Old", points: 7 },
      { characterId: newMain.id, playerId: lead.playerId, occurredAt: now, tier: "Decay", points: -50 },
    ]);
    const summaries = await getOwnedAccountActivitySummaries(db, lead.userId, now);
    const primary = summaries.find((summary) => summary.playerId === lead.playerId);
    const secondary = summaries.find((summary) => summary.playerId === secondPlayer[0].id);
    check(failures, summaries.length === 2 && secondary?.windows.all.epGained === 11, "includes every players.user_id account independently");
    check(failures, primary?.windows["24h"].epGained === 20 && primary.windows["7d"].epGained === 20 && primary.windows["30d"].epGained === 50, "computes rolling positive EP windows from occurred_at");
    check(failures, primary?.windows["24h"].gpSpent === 0 && primary.windows["7d"].gpSpent === 5 && primary.windows.all.gpSpent === 12, "computes gross positive GP spent and excludes negative rows");

    if (failures.n > 0) throw new Error(`${failures.n} raid/activity check(s) failed`);
    console.log("All raid leader, Event Lead, and activity summary checks passed.");
  } finally {
    await proxy.dispose();
    execFileSync("scripts/snapshot.sh", ["restore", SNAPSHOT], { stdio: "inherit" });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
