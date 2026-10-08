// Unit checks for event-assignment.ts using the 2026-10-07 night's real timings
// (Kess's "Emp - Raid Start" vs Sandrian's "BoT Towers"). Pure — no DB.
// Usage: npx tsx scripts/verify-event-assignment.ts
import { buildEventSpans, inferEventName } from "../src/lib/epgp/event-assignment";

let failed = 0;
const check = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failed++;
};
const at = (s: string) => new Date(`2026-10-0${s.slice(0, 1)}T${s.slice(1)}Z`);
const DATE = "2026-10-07";

const att = [
  { raidDate: null, raidName: "Emp - Raid Start", occurredAt: new Date("2026-10-08T00:35:21Z") },
  { raidDate: null, raidName: "Emp - Raid Start", occurredAt: new Date("2026-10-08T01:34:55Z") },
  { raidDate: null, raidName: "BoT Towers", occurredAt: new Date("2026-10-08T02:03:42Z") },
  { raidDate: null, raidName: null, occurredAt: new Date("2026-10-08T00:35:21Z") },
];
const spans = buildEventSpans(att);
check(spans.get(DATE)?.length === 2, "two named events on the guild date");
check(inferEventName(spans, DATE, new Date("2026-10-08T00:35:21Z")) === "Emp - Raid Start", "Event Lead at first capture → Kess");
check(inferEventName(spans, DATE, new Date("2026-10-08T01:00:04Z")) === "Emp - Raid Start", "loot mid-raid → Kess");
check(inferEventName(spans, DATE, new Date("2026-10-08T01:40:25Z")) === "Emp - Raid Start", "loot after End capture, before BoT → Kess");
check(inferEventName(spans, DATE, new Date("2026-10-08T02:10:00Z")) === "BoT Towers", "loot after BoT start → BoT");
check(inferEventName(spans, DATE, new Date("2026-10-07T23:00:00Z")) === "Emp - Raid Start", "before every capture → earliest event");
check(inferEventName(buildEventSpans(att.slice(0, 2)), DATE, at("801:00")) === null, "single named event → null (legacy merge handles it)");
check(inferEventName(buildEventSpans([]), DATE, at("801:00")) === null, "no spans → null");
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
