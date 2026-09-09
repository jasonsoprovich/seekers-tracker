// Shared input guards for the write paths that accept data from outside a
// trusted form: every /api/officer/* route (called by the standalone parser
// app with an x-api-key, not a session) and the manual ledger Server
// Actions. These routes already do typed shape checks; what was missing is
// *range* sanity — a non-finite or absurdly large points value, an
// unbounded note/item string, a date defaulted to the Unix epoch, a
// "character name" that's actually a paragraph. Drizzle parameterizes every
// query so this is not about SQL injection (there's no raw-SQL surface here
// — that's /epgp/sql, separately hardened); it's about not writing junk to
// the ledger.

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

// No legitimate single EP or GP award comes near this. Big enough that a
// real correction (a whole cycle's decay reversal entered by hand, say) is
// never blocked; small enough that a fat-fingered 100000000 is.
export const MAX_ABS_POINTS = 1_000_000;

export const LIMITS = {
  note: 500,
  itemName: 120,
  activity: 60,
  zone: 80,
  characterName: 24,
  raidName: 80,
} as const;

// EQ / Project Quarm character names are letters only, and short. Allow a
// little slack over the in-game 15-char cap for imported edge cases, but a
// name with digits, punctuation, or whitespace is a paste error, not a
// character.
const CHARACTER_NAME_RE = /^[A-Za-z]{2,24}$/;

// Anything before this on an officer-entered row is a typo (wrong year) or
// a zero-value default, not a real occurrence. Historical backfill goes
// through scripts/import-epgp.ts, not these routes.
const MIN_OCCURRED_AT = Date.parse("2015-01-01T00:00:00Z");

export function boundedNumber(
  v: unknown,
  opts: { min?: number; max?: number; integer?: boolean; field?: string } = {},
): Validated<number> {
  const field = opts.field ?? "value";
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return { ok: false, error: `\`${field}\` must be a finite number.` };
  }
  if (opts.integer && !Number.isInteger(v)) {
    return { ok: false, error: `\`${field}\` must be a whole number.` };
  }
  const min = opts.min ?? -MAX_ABS_POINTS;
  const max = opts.max ?? MAX_ABS_POINTS;
  if (v < min || v > max) {
    return { ok: false, error: `\`${field}\` must be between ${min} and ${max}.` };
  }
  return { ok: true, value: v };
}

// Trims by default. `min: 1` makes it a required non-empty field.
export function boundedString(
  v: unknown,
  opts: { max: number; min?: number; field?: string; trim?: boolean },
): Validated<string> {
  const field = opts.field ?? "value";
  if (typeof v !== "string") return { ok: false, error: `\`${field}\` must be a string.` };
  const s = opts.trim === false ? v : v.trim();
  if (s.length < (opts.min ?? 0)) return { ok: false, error: `\`${field}\` is required.` };
  if (s.length > opts.max) return { ok: false, error: `\`${field}\` must be ${opts.max} characters or fewer.` };
  return { ok: true, value: s };
}

export function characterName(v: unknown, field = "characterName"): Validated<string> {
  const s = boundedString(v, { max: LIMITS.characterName, min: 2, field });
  if (!s.ok) return s;
  if (!CHARACTER_NAME_RE.test(s.value)) {
    return { ok: false, error: `\`${field}\` "${s.value}" isn't a valid character name.` };
  }
  return s;
}

// Parses and range-checks an ISO datetime string. Rejects unparseable
// values, anything before MIN_OCCURRED_AT, and anything more than a day in
// the future (a day of slack absorbs client clock skew and timezone math).
export function isoDate(v: unknown, field = "occurredAt"): Validated<Date> {
  if (typeof v !== "string" || !v) return { ok: false, error: `\`${field}\` is required.` };
  const t = Date.parse(v);
  if (Number.isNaN(t)) return { ok: false, error: `\`${field}\` is not a valid date.` };
  const maxT = Date.now() + 24 * 60 * 60 * 1000;
  if (t < MIN_OCCURRED_AT || t > maxT) {
    return { ok: false, error: `\`${field}\` is outside the allowed range.` };
  }
  return { ok: true, value: new Date(t) };
}

// Optional free-text (note, item name, zone). null/undefined/"" -> ok with
// null; a present value is length-capped.
export function optionalText(v: unknown, max: number, field = "value"): Validated<string | null> {
  if (v === undefined || v === null) return { ok: true, value: null };
  const s = boundedString(v, { max, field });
  if (!s.ok) return s;
  return { ok: true, value: s.value || null };
}
