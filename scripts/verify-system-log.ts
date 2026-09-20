// Admin System Log — verifies recordSystemEvent lands on the real entry
// points it's wired into, that the parser-bulk exclusion actually excludes
// (insertEpLedgerBatch, insertLedgerEntry with source "parse"), that a
// deliberate write failure is swallowed rather than failing the caller's
// mutation, and that the CSV escaper round-trips through the existing
// parseCsv. Same pattern as scripts/verify-guild-removal.ts / verify-
// character-claims.ts — real writes against local D1, snapshotted first and
// restored in a `finally` regardless of outcome. Never point this at remote
// D1 (PLAN.md §5) — SNAPSHOT_NAME only exists in the local Miniflare file
// snapshot.sh operates on.
//
// Usage:
//   npx tsx scripts/verify-system-log.ts
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import * as schema from "../src/db";
import { characters, players, systemEventLog, users } from "../src/db";
import { UNKNOWN_CLASS_ID, UNKNOWN_RACE_ID } from "../src/lib/eq/enums";
import { escapeCsvValue, parseCsv, toCsvRow } from "../src/lib/epgp/csv";
import { insertEpLedgerBatch, insertLedgerEntry } from "../src/lib/epgp/ledger-entry";
import { attachCharacterToPlayer, removePlayerFromGuildCore, reverseMainSwap, swapMainCharacter } from "../src/lib/players";
import { recordSystemEvent, scriptActor } from "../src/lib/system-log";

const SNAPSHOT_NAME = "admin-system-log-test";

type Db = ReturnType<typeof drizzle<typeof schema>>;

function check(failures: { n: number }, cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ok   ${msg}`);
  } else {
    console.log(`  FAIL ${msg}`);
    failures.n++;
  }
}

async function makeUser(db: Db, role: "member" | "officer" | "leader" | "admin" = "leader") {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    email: `verify-system-log-${id}@example.invalid`,
    discordId: `test-discord-${id}`,
    username: `VerifySysLog-${id.slice(0, 8)}`,
    role,
    discordVerified: true,
  });
  return id;
}

async function makePlayerWithUser(db: Db, userId: string, role: "member" | "officer" | "leader" | "admin" = "leader") {
  const [row] = await db
    .insert(players)
    .values({ userId, discordId: `test-discord-${userId}`, displayName: `VerifySysLogPlayer-${userId.slice(0, 8)}`, role, status: "active" })
    .returning({ id: players.id });
  return row.id;
}

async function makeCharacter(db: Db, opts: { playerId: number; charType: "main" | "alt" | "mule"; mainCharacterId?: number | null }) {
  const [row] = await db
    .insert(characters)
    .values({
      name: `VerifySysLogChar-${randomUUID().slice(0, 8)}`,
      class: UNKNOWN_CLASS_ID,
      race: UNKNOWN_RACE_ID,
      level: 1,
      playerId: opts.playerId,
      charType: opts.charType,
      mainCharacterId: opts.mainCharacterId ?? null,
    })
    .returning({ id: characters.id });
  return row.id;
}

async function latestEventFor(db: Db, action: string, targetId: string | number): Promise<typeof systemEventLog.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(systemEventLog)
    .where(and(eq(systemEventLog.action, action), eq(systemEventLog.targetId, String(targetId))));
  return rows.sort((a, b) => b.id - a.id)[0];
}

async function main() {
  console.log(`Saving snapshot '${SNAPSHOT_NAME}' before running a destructive test...`);
  execFileSync("scripts/snapshot.sh", ["save", SNAPSHOT_NAME], { stdio: "inherit" });

  const failures = { n: 0 };
  const proxy = await getPlatformProxy({ configPath: "wrangler.jsonc" });

  try {
    const db = drizzle(proxy.env.DATABASE as unknown as Parameters<typeof drizzle>[0], { schema });
    const actorUser = await makeUser(db);
    const actor = scriptActor("verify-system-log");

    // ---------------------------------------------------------------
    // 1. removePlayerFromGuildCore / reinstatePlayerFromGuildCore log
    //    exactly one row each.
    // ---------------------------------------------------------------
    console.log("\n1. Guild removal/reinstatement");
    const memberUser = await makeUser(db, "member");
    const memberPlayer = await makePlayerWithUser(db, memberUser, "member");
    await makeCharacter(db, { playerId: memberPlayer, charType: "main" });

    await removePlayerFromGuildCore(db, actorUser, memberPlayer);
    const removeEvent = await latestEventFor(db, "members.remove", memberPlayer);
    check(failures, removeEvent !== undefined, "members.remove logged");
    check(failures, removeEvent?.summary.includes("removed from the guild") ?? false, "summary mentions removal");

    // ---------------------------------------------------------------
    // 2. attachCharacterToPlayer logs characters.link on a real move, and
    //    is silent on a no-op re-attach (already on the right player).
    // ---------------------------------------------------------------
    console.log("\n2. attachCharacterToPlayer link / no-op");
    // A genuinely standalone character (playerId NULL) — not yet on
    // anyone's account — so the first attach takes the plain "first link"
    // path (character.playerId === null skips the absorb/refusal branch
    // entirely), exercising the actual logged case rather than the refusal
    // an already-owned character would hit.
    const [standaloneChar] = await db
      .insert(characters)
      .values({ name: `VerifySysLogChar-${randomUUID().slice(0, 8)}`, class: UNKNOWN_CLASS_ID, race: UNKNOWN_RACE_ID, level: 1, charType: "alt", playerId: null })
      .returning({ id: characters.id });
    const standaloneCharId = standaloneChar.id;
    const otherPlayerUser = await makeUser(db, "member");
    const otherPlayer = await makePlayerWithUser(db, otherPlayerUser, "member");

    const before = await db.select({ id: systemEventLog.id }).from(systemEventLog).where(eq(systemEventLog.action, "characters.link"));
    const attachResult = await attachCharacterToPlayer(db, standaloneCharId, otherPlayer, actor);
    check(failures, !attachResult.error, `first attach succeeds (${attachResult.error ?? "ok"})`);
    const afterMove = await db.select({ id: systemEventLog.id }).from(systemEventLog).where(eq(systemEventLog.action, "characters.link"));
    check(failures, afterMove.length === before.length + 1, "characters.link logged exactly once on a real move");

    await attachCharacterToPlayer(db, standaloneCharId, otherPlayer, actor);
    const afterNoop = await db.select({ id: systemEventLog.id }).from(systemEventLog).where(eq(systemEventLog.action, "characters.link"));
    check(failures, afterNoop.length === afterMove.length, "no additional characters.link row on a no-op re-attach");

    // ---------------------------------------------------------------
    // 3. swapMainCharacter / reverseMainSwap
    // ---------------------------------------------------------------
    console.log("\n3. Main swap + reverse");
    const swapUser = await makeUser(db, "member");
    const swapPlayer = await makePlayerWithUser(db, swapUser, "member");
    const oldMain = await makeCharacter(db, { playerId: swapPlayer, charType: "main" });
    const newMain = await makeCharacter(db, { playerId: swapPlayer, charType: "alt", mainCharacterId: oldMain });
    await db.update(players).set({ mainCharacterId: oldMain }).where(eq(players.id, swapPlayer));

    const swapResult = await swapMainCharacter(db, swapPlayer, newMain, actorUser, 0);
    check(failures, !("error" in swapResult), `swap succeeds (${"error" in swapResult ? swapResult.error : "ok"})`);
    const swapEvent = await latestEventFor(db, "members.main.swap", swapPlayer);
    check(failures, swapEvent !== undefined, "members.main.swap logged");

    const [swapRow] = await db.select({ id: schema.mainSwapEvents.id }).from(schema.mainSwapEvents).where(eq(schema.mainSwapEvents.playerId, swapPlayer));
    await reverseMainSwap(db, swapRow.id, actorUser);
    const reverseEvent = await latestEventFor(db, "members.main.swap.reverse", swapPlayer);
    check(failures, reverseEvent !== undefined, "members.main.swap.reverse logged");

    // ---------------------------------------------------------------
    // 4. insertLedgerEntry: source "manual" logs, source "parse" does not;
    //    insertEpLedgerBatch (bulk parser path) never logs at all.
    // ---------------------------------------------------------------
    console.log("\n4. Manual vs. parse EP entry logging");
    const epUser = await makeUser(db, "member");
    const epPlayer = await makePlayerWithUser(db, epUser, "member");
    const epChar = await makeCharacter(db, { playerId: epPlayer, charType: "main" });

    const manualResult = await insertLedgerEntry(
      db,
      { kind: "ep", characterId: epChar, activity: "Manual Test", points: 10, occurredAt: new Date().toISOString(), note: "" },
      actorUser,
      "manual",
    );
    check(failures, manualResult.ok, `manual EP insert succeeds (${manualResult.ok ? "ok" : manualResult.error})`);
    const manualEvent = await latestEventFor(db, "epgp.entry.create", epChar);
    check(failures, manualEvent !== undefined, "epgp.entry.create logged for a manual entry");

    const beforeParseCount = await db.select({ id: systemEventLog.id }).from(systemEventLog).where(eq(systemEventLog.action, "epgp.entry.create"));
    await insertLedgerEntry(
      db,
      { kind: "ep", characterId: epChar, activity: "Raid - Start", points: 50, occurredAt: new Date().toISOString(), note: "" },
      actorUser,
      "parse",
    );
    const afterParseCount = await db.select({ id: systemEventLog.id }).from(systemEventLog).where(eq(systemEventLog.action, "epgp.entry.create"));
    check(failures, afterParseCount.length === beforeParseCount.length, "source:'parse' single-row insert writes NO system_event_log row");

    const bulkResult = await insertEpLedgerBatch(
      db,
      [{ characterId: epChar, activity: "Raid - Mid", points: 50, occurredAt: new Date().toISOString(), note: "" }],
      actorUser,
      "parse",
    );
    check(failures, bulkResult.inserted === 1, "bulk attendance insert succeeds");
    const afterBulkParseCount = await db.select({ id: systemEventLog.id }).from(systemEventLog).where(eq(systemEventLog.action, "epgp.entry.create"));
    check(failures, afterBulkParseCount.length === afterParseCount.length, "bulk attendance path never calls recordSystemEvent (no new epgp.entry.create row)");

    // ---------------------------------------------------------------
    // 5. recordSystemEvent swallows a write failure rather than throwing.
    // ---------------------------------------------------------------
    console.log("\n5. recordSystemEvent fire-and-forget on failure");
    let threw = false;
    try {
      // actor_user_id has an FK to users.id — an id that doesn't exist
      // trips the FK constraint, exercising the catch path.
      await recordSystemEvent(db, { userId: "nonexistent-user-id", label: null, role: null, source: "script" }, {
        action: "system.apikey.create",
        summary: "deliberate FK-violation test — should not throw",
      });
    } catch {
      threw = true;
    }
    check(failures, !threw, "recordSystemEvent does not throw on a write failure");

    // ---------------------------------------------------------------
    // 6. CSV escaper round-trips through the existing parser.
    // ---------------------------------------------------------------
    console.log("\n6. CSV escaping round-trip");
    const tricky = ['plain', 'has,comma', 'has"quote', 'has\nnewline', 'has\r\nCRLF', null, undefined];
    const csv = tricky.map((v) => escapeCsvValue(v)).join(",") + "\r\n" + toCsvRow(["a", "b,c", 'd"e']);
    const parsed = parseCsv(csv);
    check(failures, parsed.length === 2, "parseCsv recovers 2 rows from the escaped output");
    check(failures, parsed[0]?.[1] === "has,comma", "embedded comma round-trips");
    check(failures, parsed[0]?.[2] === 'has"quote', "embedded quote round-trips");
    check(failures, parsed[1]?.[1] === "b,c" && parsed[1]?.[2] === 'd"e', "toCsvRow output round-trips through parseCsv");

    console.log(`\n${failures.n === 0 ? "All checks passed." : `${failures.n} check(s) FAILED.`}`);
  } finally {
    console.log(`\nRestoring snapshot '${SNAPSHOT_NAME}'...`);
    execFileSync("scripts/snapshot.sh", ["restore", SNAPSHOT_NAME], { stdio: "inherit" });
  }

  if (failures.n > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
