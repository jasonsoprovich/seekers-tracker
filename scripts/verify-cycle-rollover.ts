// Cycle rollover on global cycle decay (2026-10-23): committing a
// global_cycle decay ends the running cycle at the decay instant and opens
// the next; reversing it reopens the previous cycle. Runs the real
// commitRateDecay / reverseDecayEvent / insertLedgerEntry / getCurrentCycleEp
// entry points against local D1. A snapshot is restored in finally; never
// point this at remote D1.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import * as schema from "../src/db";
import { characters, cycles, epLedger, players, users } from "../src/db";
import { bucketRange, type Cycle, cycleWindows, getCurrentCycleWindow, windowAt } from "../src/lib/epgp/cycles";
import { commitRateDecay, reverseDecayEvent } from "../src/lib/epgp/decay";
import { getCurrentCycleEp } from "../src/lib/epgp/ep-cap";
import { insertLedgerEntry } from "../src/lib/epgp/ledger-entry";
import { UNKNOWN_CLASS_ID, UNKNOWN_RACE_ID } from "../src/lib/eq/enums";

const SNAPSHOT = "verify-cycle-rollover";
const HOUR = 3_600_000;
type Db = ReturnType<typeof drizzle<typeof schema>>;

function check(failures: { n: number }, condition: boolean, message: string) {
  console.log(`  ${condition ? "ok  " : "FAIL"} ${message}`);
  if (!condition) failures.n++;
}

function cycle(id: number, cycleNumber: number, start: string, end: string, startedByDecayEventId: number | null = null): Cycle {
  return { id, cycleNumber, startDate: new Date(start), endDate: new Date(end), startedByDecayEventId };
}

function windowRules(failures: { n: number }) {
  console.log("Cycle windows (pure)");
  // Two calendar cycles, then one opened by a decay at 11:50pm ET on 10/31.
  const rolledAt = "2026-11-01T03:50:00Z";
  const windows = cycleWindows([
    cycle(1, 69, "2026-10-01T00:00:00Z", "2026-10-17T00:00:00Z"),
    cycle(2, 70, "2026-10-18T00:00:00Z", rolledAt),
    cycle(3, 71, rolledAt, rolledAt, 99),
  ]);
  const numberAt = (t: string) => windowAt(windows, new Date(t))?.cycle.cycleNumber;
  check(failures, numberAt("2026-10-18T03:30:00Z") === 69, "11:30pm ET on 10/17 is still the calendar cycle");
  check(failures, numberAt("2026-10-18T04:30:00Z") === 70, "12:30am ET on 10/18 starts the next calendar cycle");
  check(failures, numberAt("2026-11-01T03:40:00Z") === 70, "10 minutes before the decay counts in the old cycle");
  check(failures, numberAt("2026-11-01T03:55:00Z") === 71, "5 minutes after the decay counts in the new cycle");
  check(failures, numberAt("2026-10-31T00:00:00Z") === 70, "a date-only row on the decay day (noon before the 11:50pm decay) is the old cycle");
  check(failures, numberAt("2026-11-01T00:00:00Z") === 71, "a date-only row the day after is the new cycle");
  check(failures, numberAt("2027-06-01T00:00:00Z") === 71, "the running cycle has no end");
  check(failures, windows[2].open && !windows[1].open, "only the latest cycle is open");

  const b70 = bucketRange(windows[1]);
  const b71 = bucketRange(windows[2]);
  check(failures, b70.from.toISOString().startsWith("2026-10-18") && b70.to.toISOString().startsWith("2026-10-31"), `old cycle's date-only rows are 10/18-10/31 (${b70.from.toISOString().slice(0, 10)}..${b70.to.toISOString().slice(0, 10)})`);
  check(failures, b71.from.toISOString().startsWith("2026-11-01"), "new cycle's date-only rows start 11/1");
  const b69 = bucketRange(windows[0]);
  check(failures, b69.from.toISOString().startsWith("2026-10-01") && b69.to.toISOString().startsWith("2026-10-17"), "calendar cycle keeps its own first..last day");
}

async function fixture(db: Db) {
  const suffix = randomUUID();
  const userId = `verify-rollover-${suffix}`;
  await db.insert(users).values({ id: userId, email: `${userId}@example.invalid`, username: userId, discordId: userId, role: "leader" });
  const [player] = await db.insert(players).values({ userId, displayName: userId, role: "leader" }).returning({ id: players.id });
  const [character] = await db
    .insert(characters)
    .values({ name: `Roll${suffix.slice(0, 8)}`, class: UNKNOWN_CLASS_ID, race: UNKNOWN_RACE_ID, level: 1, charType: "main", playerId: player.id })
    .returning({ id: characters.id });
  await db.update(players).set({ mainCharacterId: character.id }).where(eq(players.id, player.id));
  return { userId, playerId: player.id, characterId: character.id };
}

async function award(db: Db, ids: Awaited<ReturnType<typeof fixture>>, at: Date, points: number) {
  const result = await insertLedgerEntry(db, { kind: "ep", characterId: ids.characterId, activity: "Raid - End", points, occurredAt: at.toISOString(), note: "rollover test" }, ids.userId, "parse");
  if (!result.ok) throw new Error(result.error);
  const rows = await db.select().from(epLedger).where(eq(epLedger.characterId, ids.characterId)).orderBy(epLedger.id);
  return rows.at(-1)!;
}

async function main() {
  const failures = { n: 0 };
  windowRules(failures);

  execFileSync("scripts/snapshot.sh", ["save", SNAPSHOT], { stdio: "inherit" });
  const proxy = await getPlatformProxy({ configPath: "wrangler.jsonc" });
  const db = drizzle(proxy.env.DATABASE as unknown as Parameters<typeof drizzle>[0], { schema });

  try {
    const ids = await fixture(db);
    const before = await getCurrentCycleWindow(db);
    if (!before) throw new Error("local D1 has no cycle");
    const startNumber = before.cycle.cycleNumber;
    console.log(`Rollover against local D1 (running cycle #${startNumber})`);
    check(failures, before.open, "the running cycle is open before any rollover");

    const now = Date.now();
    const decayAt = new Date(now - 3 * HOUR);
    const beforeDecay = await award(db, ids, new Date(now - 4 * HOUR), 30);
    check(failures, beforeDecay.cycleId === before.cycle.id, "an award before the decay is stamped with the running cycle");

    const effectiveDate = new Date(`${decayAt.toISOString().slice(0, 10)}T00:00:00Z`);
    const commit = await commitRateDecay(db, { kind: "global_cycle", rate: 0.1, effectiveDate, cutoff: decayAt, appliedBy: ids.userId });
    if ("error" in commit) throw new Error(commit.error);
    check(failures, commit.cycleStarted === startNumber + 1, `commit reports cycle #${startNumber + 1} started`);

    const after = await getCurrentCycleWindow(db);
    const [closed] = await db.select().from(cycles).where(eq(cycles.id, before.cycle.id));
    check(failures, after?.cycle.cycleNumber === startNumber + 1 && after.open, "the new cycle is current and open");
    check(failures, after?.cycle.startedByDecayEventId === commit.decayEventId, "the new cycle is linked to the decay");
    check(failures, after?.start.getTime() === Math.floor(decayAt.getTime() / 1000) * 1000, "the new cycle starts at the decay instant");
    check(failures, closed.endDate.getTime() === Math.floor(decayAt.getTime() / 1000) * 1000, "the old cycle ends at the decay instant");

    const afterDecay = await award(db, ids, new Date(now - 2 * HOUR), 40);
    check(failures, afterDecay.cycleId === after?.cycle.id, "an award after the decay is stamped with the new cycle");
    const meter = await getCurrentCycleEp(db, [ids.playerId]);
    check(failures, meter?.usedByPlayer.get(ids.playerId) === 40 && meter.open, `cap meter counts only the new cycle's EP (${meter?.usedByPlayer.get(ids.playerId)})`);

    const tooEarly = await commitRateDecay(db, { kind: "global_cycle", rate: 0.1, effectiveDate: new Date(effectiveDate.getTime() - 86_400_000), cutoff: new Date(decayAt.getTime() - HOUR), appliedBy: ids.userId });
    check(failures, "error" in tooEarly && /started after that date/.test(tooEarly.error), "a decay dated before the running cycle started is refused");

    console.log("Reversal");
    const reversed = await reverseDecayEvent(db, commit.decayEventId, ids.userId);
    check(failures, "ok" in reversed, "the decay reverses");
    const reopened = await getCurrentCycleWindow(db);
    const [moved] = await db.select().from(epLedger).where(eq(epLedger.id, afterDecay.id));
    const gone = await db.select().from(cycles).where(eq(cycles.cycleNumber, startNumber + 1));
    check(failures, reopened?.cycle.id === before.cycle.id && reopened.open, "the previous cycle is current and open again");
    check(failures, gone.length === 0, "the cycle the decay started is removed");
    check(failures, moved.cycleId === before.cycle.id, "rows stamped with the removed cycle move back");
    const meterBack = await getCurrentCycleEp(db, [ids.playerId]);
    check(failures, meterBack?.usedByPlayer.get(ids.playerId) === 70, "cap meter counts both awards again");

    console.log("Back-to-back rollovers");
    const first = await commitRateDecay(db, { kind: "global_cycle", rate: 0.1, effectiveDate, cutoff: decayAt, appliedBy: ids.userId });
    if ("error" in first) throw new Error(first.error);
    const secondAt = new Date(now - HOUR);
    const second = await commitRateDecay(db, { kind: "global_cycle", rate: 0.1, effectiveDate: new Date(effectiveDate.getTime() + 86_400_000), cutoff: secondAt, appliedBy: ids.userId });
    if ("error" in second) throw new Error(second.error);
    check(failures, second.cycleStarted === startNumber + 2, "a second decay starts the cycle after that");
    const blocked = await reverseDecayEvent(db, first.decayEventId, ids.userId);
    check(failures, "error" in blocked && /reverse the later cycle decay first/.test(blocked.error), "reversing the earlier decay is refused while a later one stands");
    const undoSecond = await reverseDecayEvent(db, second.decayEventId, ids.userId);
    const undoFirst = await reverseDecayEvent(db, first.decayEventId, ids.userId);
    const finalCycle = await getCurrentCycleWindow(db);
    check(failures, "ok" in undoSecond && "ok" in undoFirst && finalCycle?.cycle.id === before.cycle.id, "reversing newest-first unwinds back to the original cycle");

    const expansion = await commitRateDecay(db, { kind: "expansion", rate: 0.9, effectiveDate, cutoff: decayAt, appliedBy: ids.userId });
    const afterExpansion = await getCurrentCycleWindow(db);
    check(failures, !("error" in expansion) && expansion.cycleStarted === undefined && afterExpansion?.cycle.id === before.cycle.id, "an expansion decay doesn't roll the cycle");
  } finally {
    await proxy.dispose();
    execFileSync("scripts/snapshot.sh", ["restore", SNAPSHOT], { stdio: "inherit" });
  }

  if (failures.n > 0) {
    console.error(`${failures.n} cycle rollover check(s) failed`);
    process.exit(1);
  }
  console.log("All cycle rollover checks passed.");
}

main();
