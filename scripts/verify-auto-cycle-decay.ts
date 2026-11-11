// npm run verify:auto-cycle-decay — the automatic cycle decay
// (src/lib/epgp/auto-cycle-decay.ts) and the cycle calendar it reads
// (cycles.ts scheduledCycleEnd / decayReminder). Pure checks first, then the
// real runScheduledCycleDecay against local D1 with a simulated clock,
// snapshot/restore around it. Expects local D1's running cycle to be the
// sheet's calendar cycle #70 (10/18-10/31), as the seed leaves it.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import * as schema from "../src/db";
import { decayEvents, users } from "../src/db";
import { autoCycleDecayRate, runScheduledCycleDecay, setAutoCycleDecay } from "../src/lib/epgp/auto-cycle-decay";
import { type Cycle, cycleWindows, decayReminder, getCurrentCycleWindow, scheduledCycleEnd } from "../src/lib/epgp/cycles";
import { commitRateDecay } from "../src/lib/epgp/decay";
import { scriptActor } from "../src/lib/system-log";

const SNAPSHOT = "verify-auto-cycle-decay";
const HOUR = 3_600_000;

function check(failures: { n: number }, condition: boolean, message: string) {
  console.log(`  ${condition ? "ok  " : "FAIL"} ${message}`);
  if (!condition) failures.n++;
}

function cycle(id: number, cycleNumber: number, start: string, end: string, startedByDecayEventId: number | null = null): Cycle {
  return { id, cycleNumber, startDate: new Date(start), endDate: new Date(end), startedByDecayEventId };
}

// The open window for a cycle a decay opened at `startedAt`.
function decayOpened(startedAt: string) {
  return cycleWindows([cycle(1, 70, "2026-10-18T00:00:00Z", "2026-10-31T00:00:00Z"), cycle(2, 71, startedAt, startedAt, 9)])[1];
}

function pure(failures: { n: number }) {
  console.log("Scheduled cycle end (pure)");
  const end = (startedAt: string) => scheduledCycleEnd(decayOpened(startedAt));
  const onTime = end("2026-11-01T04:00:00Z");
  check(failures, onTime?.lastDay === "2026-11-14", `cycle opened at midnight ET 11/1 ends Sat 11/14 (${onTime?.lastDay})`);
  check(failures, onTime?.decayAt.toISOString() === "2026-11-15T05:00:00.000Z", `decay due at midnight EST = 05:00Z 11/15 (${onTime?.decayAt.toISOString()})`);
  check(failures, end("2026-11-01T03:30:00Z")?.lastDay === "2026-11-14", "a decay run 11:30pm Sat 10/31 still lines up with the calendar");
  check(failures, end("2026-11-02T20:00:00Z")?.lastDay === "2026-11-14", "a decay run late on Monday 11/2 still lines up with the calendar");
  check(failures, end("2026-11-15T05:00:00Z")?.lastDay === "2026-11-28", "the next cycle ends Sat 11/28");
  // DST starts 3/14/2027 inside the 3/7-3/20 cycle: due at midnight EDT.
  const dst = end("2027-03-07T05:00:00Z");
  check(failures, dst?.lastDay === "2027-03-20" && dst.decayAt.toISOString() === "2027-03-21T04:00:00.000Z", `across DST: due 04:00Z 3/21 (${dst?.decayAt.toISOString()})`);

  const calendar = cycleWindows([cycle(1, 70, "2026-10-18T00:00:00Z", "2026-10-31T00:00:00Z")])[0];
  const cal = scheduledCycleEnd(calendar);
  check(failures, cal?.lastDay === "2026-10-31" && cal.decayAt.toISOString() === "2026-11-01T04:00:00.000Z", `a calendar cycle keeps its planned end, midnight EDT (${cal?.decayAt.toISOString()})`);
  const closed = cycleWindows([cycle(1, 70, "2026-10-18T00:00:00Z", "2026-10-31T00:00:00Z"), cycle(2, 71, "2026-11-01T00:00:00Z", "2026-11-14T00:00:00Z")])[0];
  check(failures, scheduledCycleEnd(closed) === null, "a closed cycle has no scheduled end");

  console.log("Reminder (pure)");
  const w = decayOpened("2026-11-01T04:00:00Z");
  const at = (t: string) => new Date(t);
  check(failures, decayReminder(w, true, at("2026-11-14T20:00:00Z")) === null, "auto on: no dot before the cycle ends");
  check(failures, decayReminder(w, true, at("2026-11-15T06:00:00Z")) === null, "auto on: no dot in the first hours after (cron retrying)");
  check(failures, decayReminder(w, true, at("2026-11-15T08:00:00Z"))?.tone === "due", "auto on: red dot once the cron has clearly missed it");
  check(failures, decayReminder(w, false, at("2026-11-12T15:00:00Z"))?.tone === "soon", "auto off: orange dot 2 days out");
  check(failures, decayReminder(w, false, at("2026-11-14T15:00:00Z"))?.title === "Cycle decay is due tonight", "auto off: due tonight on the last day");
  check(failures, decayReminder(w, false, at("2026-11-08T15:00:00Z")) === null, "auto off: nothing a week out");
}

async function main() {
  const failures = { n: 0 };
  pure(failures);

  execFileSync("scripts/snapshot.sh", ["save", SNAPSHOT], { stdio: "inherit" });
  const proxy = await getPlatformProxy({ configPath: "wrangler.jsonc" });
  const db = drizzle(proxy.env.DATABASE as unknown as Parameters<typeof drizzle>[0], { schema });

  try {
    const userId = `verify-auto-decay-${randomUUID()}`;
    await db.insert(users).values({ id: userId, email: `${userId}@example.invalid`, username: userId, discordId: userId, role: "leader" });

    const start = await getCurrentCycleWindow(db, new Date("2026-10-31T12:00:00Z"));
    if (start?.cycle.cycleNumber !== 70 || start.cycle.startedByDecayEventId != null) throw new Error(`expected calendar cycle #70 running on 10/31, got #${start?.cycle.cycleNumber}`);
    console.log("Automatic decay against local D1 (simulated clock)");

    const early = await runScheduledCycleDecay(db, new Date("2026-11-01T03:59:00Z"));
    check(failures, early.status === "not-due", `11:59pm ET 10/31: not due yet (${early.status})`);

    const first = await runScheduledCycleDecay(db, new Date("2026-11-01T04:00:20Z"));
    check(failures, first.status === "committed" && first.cycleStarted === 71 && first.epRows > 0, `midnight ET: decay committed and cycle #71 opened (${first.status})`);
    if (first.status !== "committed") throw new Error(JSON.stringify(first));
    const [event] = await db.select().from(decayEvents).where(eq(decayEvents.id, first.decayEventId));
    check(failures, event.kind === "global_cycle" && event.epRate === 0.1 && event.appliedBy === null, "global_cycle at 10% (no earlier cycle decay), applied by no user");
    check(failures, event.effectiveDate.toISOString() === "2026-10-31T00:00:00.000Z", "dated the cycle's last day (10/31)");
    const c71 = await getCurrentCycleWindow(db, new Date("2026-11-02T00:00:00Z"));
    check(failures, c71?.cycle.cycleNumber === 71 && c71.start.toISOString() === "2026-11-01T04:00:00.000Z", "cycle #71 starts exactly at midnight ET");
    check(failures, c71 ? scheduledCycleEnd(c71)?.lastDay === "2026-11-14" : false, "cycle #71 is scheduled to end Sat 11/14");

    const again = await runScheduledCycleDecay(db, new Date("2026-11-01T05:00:00Z"));
    check(failures, again.status === "not-due", `the next hourly run finds nothing due (${again.status})`);

    const manual = await commitRateDecay(db, { kind: "global_cycle", rate: 0.1, effectiveDate: new Date("2026-11-01T00:00:00Z"), cutoff: new Date("2026-11-01T15:00:00Z"), appliedBy: userId });
    check(failures, "error" in manual && /already been decayed/.test(manual.error), "a leader re-running it by hand the next morning is refused");

    const second = await runScheduledCycleDecay(db, new Date("2026-11-15T05:00:15Z"));
    check(failures, second.status === "committed" && second.cycleStarted === 72, `11/15 midnight EST: cycle #72 opened (${second.status})`);
    check(failures, second.status === "committed" && second.rate === 0.1, "uses the last cycle decay's rate");

    await setAutoCycleDecay(db, false, userId, scriptActor("verify-auto-cycle-decay"));
    const off = await runScheduledCycleDecay(db, new Date("2026-11-29T05:00:15Z"));
    check(failures, off.status === "off", `switched off: nothing runs (${off.status})`);

    await setAutoCycleDecay(db, true, userId, scriptActor("verify-auto-cycle-decay"));
    const late = await runScheduledCycleDecay(db, new Date("2026-11-30T06:00:00Z"));
    check(failures, late.status === "too-late", `switched back on over a day late: left for the leader, not back-applied (${late.status})`);

    const rate = await autoCycleDecayRate(db);
    check(failures, rate === 0.1, "rate helper reads the last cycle decay");
  } finally {
    await proxy.dispose();
    execFileSync("scripts/snapshot.sh", ["restore", SNAPSHOT], { stdio: "inherit" });
  }

  if (failures.n > 0) {
    console.error(`${failures.n} automatic cycle decay check(s) failed`);
    process.exit(1);
  }
  console.log("All automatic cycle decay checks passed.");
}

main();
