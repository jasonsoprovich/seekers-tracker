import { toGuildDateString } from "../guild-timezone";

// Parser-written loot (loot_events, parse gp_ledger rows, the Event Lead ep
// row) carries no event name — only attendance rows do. When one guild date
// holds two or more named events, that unnamed activity is assigned to
// whichever event it happened during, by time. A single named event per date
// is handled by the older "fold into the only event" merge in raids.ts, so
// this returns null there.

export type EventSpan = { name: string; start: number; end: number };
export type EventSpans = Map<string, EventSpan[]>;

// Spans come from named attendance rows only, keyed by guild date.
export function buildEventSpans(
  rows: Iterable<{ raidDate: string | null; raidName: string | null; occurredAt: Date }>,
): EventSpans {
  const byDateName = new Map<string, EventSpan>();
  for (const r of rows) {
    if (!r.raidName) continue;
    const date = r.raidDate ?? toGuildDateString(r.occurredAt);
    const key = `${date}\u0000${r.raidName}`;
    const t = r.occurredAt.getTime();
    const span = byDateName.get(key);
    if (span) {
      span.start = Math.min(span.start, t);
      span.end = Math.max(span.end, t);
    } else {
      byDateName.set(key, { name: r.raidName, start: t, end: t });
    }
  }
  const spans: EventSpans = new Map();
  for (const [key, span] of byDateName) {
    const date = key.split("\u0000")[0];
    spans.set(date, [...(spans.get(date) ?? []), span]);
  }
  return spans;
}

// The event an unnamed row belongs to, or null when the date has fewer than
// two named events (nothing to disambiguate). Latest-started event at or
// before the row wins — a drop after the End capture but before the next
// event starts still belongs to the raid that was running. A row before every
// capture goes to the earliest event.
export function inferEventName(spans: EventSpans, date: string, at: Date): string | null {
  const list = spans.get(date);
  if (!list || list.length < 2) return null;
  const t = at.getTime();
  let preceding: EventSpan | null = null;
  for (const s of list) {
    if (s.start <= t && (preceding === null || s.start > preceding.start)) preceding = s;
  }
  if (preceding) return preceding.name;
  return list.reduce((a, b) => (b.start < a.start ? b : a)).name;
}
