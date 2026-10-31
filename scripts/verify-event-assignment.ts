// Unit checks for event-assignment.ts using the 2026-10-07 night's real timings
// (Kess's "Emp - Raid Start" vs Sandrian's "BoT Towers"). Pure — no DB.
// Usage: npx tsx scripts/verify-event-assignment.ts
import { buildEventSpans, inferEventName } from "../src/lib/epgp/event-assignment";
import { raidNightBounds, toRaidNightString } from "../src/lib/guild-timezone";

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
// 2026-10-30 TT/Bert/Torment: Raid - End at 11:25 PM EDT, last drop at 12:01 AM.
// Both belong to the 10/30 raid night, not a separate 10/31 event.
check(toRaidNightString(new Date("2026-10-31T03:25:00Z")) === "2026-10-30", "11:25 PM capture → 10/30 night");
check(toRaidNightString(new Date("2026-10-31T04:01:00Z")) === "2026-10-30", "12:01 AM drop → 10/30 night");
check(toRaidNightString(new Date("2026-10-31T10:00:00Z")) === "2026-10-31", "6:00 AM → next night");
const lateSpans = buildEventSpans([
  { raidDate: null, raidName: "TT, Bert, Torment", occurredAt: new Date("2026-10-31T00:30:00Z") },
  { raidDate: null, raidName: "TT, Bert, Torment", occurredAt: new Date("2026-10-31T04:05:00Z") },
]);
check(lateSpans.get("2026-10-30")?.length === 1 && !lateSpans.has("2026-10-31"), "post-midnight End capture stays in the same event");
const b = raidNightBounds("2026-10-31")!;
check(b.start.toISOString() === "2026-10-31T10:00:00.000Z" && b.end.toISOString() === "2026-11-01T11:00:00.000Z", "night bounds absorb the 11/1 DST change");
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
