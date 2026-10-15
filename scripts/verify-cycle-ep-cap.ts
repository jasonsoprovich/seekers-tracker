// Per-cycle EP cap: display + edit path, 2026-10-14. Exercises, against
// local D1:
//   A) getCurrentCycleEp (the Your Characters meter) agrees with what the
//      write path clamps against, including a partial and a zero award
//   B) listLedgerRows carries points_nominal / cap_applied for the EP log tag
//   C) resolveEpEditPoints: an officer edit re-applies the cap without
//      counting the row against itself, a note-only edit leaves points alone,
//      the cap note never stacks, a date move keeps the nominal amount
//
// Same technique as verify-pre-golive-fixes.ts: real library entry points via
// getPlatformProxy, snapshot first and restored in a `finally`. Never point
// this at remote D1.
//
// Usage: npx tsx scripts/verify-cycle-ep-cap.ts
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import * as schema from "../src/db";
import { characters, epLedger, players, users } from "../src/db";
import { getCurrentCycleEp, resolveEpEditPoints, stripCapNote } from "../src/lib/epgp/ep-cap";
import { insertLedgerEntry } from "../src/lib/epgp/ledger-entry";
import { listLedgerRows } from "../src/lib/epgp/ledger-list";
import { UNKNOWN_CLASS_ID, UNKNOWN_RACE_ID } from "../src/lib/eq/enums";
import { toGuildDateString } from "../src/lib/guild-timezone";

const SNAPSHOT_NAME = "cycle-ep-cap-verify";

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
      email: `verify-cap-${officer}@example.invalid`,
      username: `VerifyCap-${officer.slice(0, 8)}`,
      role: "officer",
    });
    const c = await makeCharacter(db, `Capverify${randomUUID().slice(0, 6)}`);
    const today = toGuildDateString(new Date());
    const ep = (points: number, note = "", bypassCap = false) =>
      insertLedgerEntry(db, { kind: "ep", characterId: c.characterId, activity: "Raid - Mid", points, occurredAt: today, note, bypassCap }, officer, "manual");
    const used = async () => (await getCurrentCycleEp(db, [c.playerId]))?.usedByPlayer.get(c.playerId) ?? 0;

    // -----------------------------------------------------------------
    console.log("\nA) current-cycle meter matches enforcement");
    const start = await getCurrentCycleEp(db, [c.playerId]);
    if (!start || start.cap === null) throw new Error("local D1 has no current cycle / cap — can't run this check");
    const cap = start.cap;
    console.log(`  (cycle #${start.cycle.cycleNumber}, cap ${cap})`);
    check(failures, (await used()) === 0, "a fresh player starts the cycle at 0");

    const big = await ep(cap - 50);
    check(failures, big.ok && (await used()) === cap - 50, `${cap - 50} EP shows as ${cap - 50} used`);

    const partial = await ep(100, "Kill bonus");
    check(failures, partial.ok && partial.capped?.awarded === 50 && partial.capped.nominal === 100, "a 100 EP award with 50 room records 50 of 100");
    check(failures, (await used()) === cap, "meter reads exactly the cap after the partial award");

    const zero = await ep(50);
    check(failures, zero.ok && zero.capped?.awarded === 0, "an award at the cap records 0");
    check(failures, (await used()) === cap, "meter unchanged by the 0 award");

    // -----------------------------------------------------------------
    console.log("\nB) EP log rows carry the cap columns");
    const listed = await listLedgerRows(db, { kind: "ep", q: c.name, pageSize: 20 });
    const cappedRows = listed.rows.filter((r) => r.capApplied);
    check(failures, listed.rows.length === 3, "all three rows listed");
    check(failures, cappedRows.length === 2, "both clamped rows flagged capApplied");
    const partialListed = cappedRows.find((r) => r.points === 50);
    check(failures, partialListed?.pointsNominal === 100, "partial row lists points 50 / nominal 100");
    check(failures, listed.rows.some((r) => !r.capApplied && r.points === cap - 50), "uncapped row stays unflagged");

    // -----------------------------------------------------------------
    console.log("\nC) officer edits");
    const partialRow = (await db.select().from(epLedger).where(eq(epLedger.characterId, c.characterId))).find((r) => r.pointsNominal === 100)!;
    const bigRow = (await db.select().from(epLedger).where(eq(epLedger.characterId, c.characterId))).find((r) => r.points === cap - 50)!;
    const todayDate = partialRow.occurredAt;

    const noteOnly = await resolveEpEditPoints(db, partialRow, { points: partialRow.points, occurredAt: todayDate, dateChanged: false, note: "renamed" });
    check(failures, Object.keys(noteOnly.fields).length === 0 && noteOnly.capped === undefined, "note-only edit leaves points/cap columns untouched");

    const up = await resolveEpEditPoints(db, partialRow, { points: 80, occurredAt: todayDate, dateChanged: false, note: partialRow.note ?? "" });
    check(failures, up.fields.points === 50 && up.fields.pointsNominal === 80 && up.capped?.awarded === 50, "raising a capped row to 80 still lands 50 (row not counted against itself)");
    check(failures, (up.note?.match(/EP capped/g) ?? []).length === 1 && up.note!.startsWith("Kill bonus"), "re-capped note keeps the officer text with exactly one cap note");

    const down = await resolveEpEditPoints(db, bigRow, { points: cap - 100, occurredAt: todayDate, dateChanged: false, note: "" });
    check(failures, down.fields.points === cap - 100 && down.fields.capApplied === false && down.note === null, "lowering an uncapped row stays uncapped");
    await db.update(epLedger).set({ ...down.fields, note: down.note }).where(eq(epLedger.id, bigRow.id));
    check(failures, (await used()) === cap - 50, "meter drops by the 50 the edit freed up");

    const freed = await resolveEpEditPoints(db, partialRow, { points: 100, occurredAt: todayDate, dateChanged: false, note: partialRow.note ?? "" });
    check(failures, freed.fields.points === 100 && freed.fields.capApplied === false && freed.capped === undefined, "with room freed, the edit to 100 lands in full");
    check(failures, freed.note === "Kill bonus", "the stale cap note is removed when no longer capped");

    const cycleStart = start.cycle.startDate;
    const lastCycle = new Date(cycleStart.getTime() - 2 * 86_400_000);
    const moved = await resolveEpEditPoints(db, partialRow, { points: partialRow.points, occurredAt: lastCycle, dateChanged: true, note: partialRow.note ?? "" });
    check(failures, moved.fields.pointsNominal === 100 && moved.fields.points === 100 && moved.fields.cycleId !== start.cycle.id, "a date move into an empty previous cycle restores the 100 nominal");

    // A negative correction is never clamped and frees room.
    const corr = await ep(-200, "Correction");
    check(failures, corr.ok && corr.capped === undefined && (await used()) === cap - 250, "a negative correction is not clamped and lowers the meter");

    // bypassCap entries count, and the meter can read over the cap.
    const over = await ep(400, "", true);
    check(failures, over.ok && over.capped === undefined && (await used()) === cap + 150, "a bypassCap award counts and the meter can exceed the cap");

    check(failures, stripCapNote("EP capped: already at the 900 EP cycle cap (0 of 50 EP awarded)") === "", "stripCapNote clears a cap-only note");
    check(failures, stripCapNote("Late — EP capped at the 900 EP cycle cap (30 of 50 EP awarded)") === "Late", "stripCapNote keeps the officer's text");
    check(failures, stripCapNote("Note about capped gear") === "Note about capped gear", "stripCapNote leaves an unrelated note alone");

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
