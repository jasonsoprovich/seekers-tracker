// Converts the guild's hand-maintained EPGP Google Sheet (downloaded as
// .xlsx) into SQL that seeds ep_ledger/gp_ledger/cycles/epgp_* — see
// docs/guild-website-feasibility.md and the EPGP plan for background.
//
// It emits a .sql file you apply with `wrangler d1 execute`, so a
// re-snapshot is one review-able diff, not a live write from a dev machine.
// (`--mode sync` additionally reads the *current* row keys back from the
// target DB — one SELECT via `wrangler d1 execute --json` — to work out the
// diff; it still only ever writes through the emitted .sql.)
//
// Usage:
//   npx tsx scripts/import-epgp.ts --file "/path/to/SoS - EPGP.xlsx" [--out <path>] [--mode reset|sync] [--remote]
//   wrangler d1 execute seekers-of-souls --local --file=drizzle/seed/epgp-import.sql
//
// --mode reset (default; --wipe is the old alias): full reload — prepend
//   DELETEs for the EPGP ledger/config tables, then re-INSERT every row.
//   ~140K row writes (deletes + inserts + the player_id backfill). Fine
//   against local D1 (unlimited); the right call for the one-time
//   production snapshot. Too heavy for repeated remote re-syncs.
//
// --mode sync: reconcile an already-seeded DB against a fresh sheet export
//   by INSERT/UPDATE/DELETE of only the ledger rows that actually changed.
//   The guild's master sheet is read-only to us, so there's no per-row id
//   column to key on — instead each row's ep_ledger/gp_ledger.source_key is
//   a content hash the importer derives itself: sha1 of the row's *identity*
//   (character name + date + activity/item + a tie-break ordinal for rows
//   that are otherwise identical, numbered in sheet order). A value edit to
//   an existing row (points, note, tier, cycle) keeps the same key and
//   comes through as an UPDATE; a change to name/date/activity/item, or an
//   inserted/deleted row, is a DELETE + INSERT. A typical weekly delta is a
//   few hundred writes vs. ~140K — safe to run repeatedly against remote
//   D1's 100K/day write cap while officers keep editing the live sheet.
//   Needs the DB seeded by `--mode reset` at least once first (so every
//   import row already has a source_key to match); add `--remote` to diff
//   against production D1.
//
// Neither mode touches `characters` beyond `INSERT OR IGNORE` + a class
// backfill — real site accounts and previously-imported roster rows are
// preserved. Both modes end with a correlated UPDATE that fills
// ep_ledger/gp_ledger.player_id from characters.player_id for any freshly
// written row whose character is already linked to a player (run
// `derive:players` first if the sync report lists brand-new characters).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import ExcelJS from "exceljs";

import { CHAR_CLASSES, UNKNOWN_CLASS_ID, UNKNOWN_RACE_ID } from "../src/lib/eq/enums";

type Cell = ExcelJS.Cell;
type Row = ExcelJS.Row;
type Worksheet = ExcelJS.Worksheet;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

const filePath = arg("file");
if (!filePath) {
  console.error("Usage: tsx scripts/import-epgp.ts --file <path to .xlsx> [--out <path>] [--mode reset|sync] [--remote]");
  process.exit(1);
}

const rawMode = arg("mode");
if (rawMode && rawMode !== "reset" && rawMode !== "sync") {
  console.error(`--mode must be "reset" or "sync" (got "${rawMode}").`);
  process.exit(1);
}
// --wipe is the old spelling of --mode reset; default stays reset.
const mode: "reset" | "sync" = rawMode === "sync" ? "sync" : "reset";
// Legacy: a bare run (no --mode, no --wipe) stays non-destructive; --wipe or
// an explicit --mode reset does the full DELETE + reload.
const wipe = mode === "reset" && (hasFlag("wipe") || rawMode === "reset");
const remote = hasFlag("remote");
const d1Target = remote ? "--remote" : "--local";
const outPath = resolve(arg("out") ?? (mode === "sync" ? "drizzle/seed/epgp-sync.sql" : "drizzle/seed/epgp-import.sql"));

// Field separator for the content-hash inputs — a control char that can't
// occur in any sheet cell, so "A|B" and "AB|" (etc.) can't collide.
const HASH_SEP = "\u0001";
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

// ---------- cell helpers ----------

// Formula cells (Totals/Get Priority both compute live) come back as
// { formula, result } rather than a plain value — unwrap to the cached
// result, same as `data_only=True` did in the openpyxl exploration this
// script's mapping was verified against.
function cellRaw(cell: Cell): unknown {
  const v: unknown = cell.value;
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if ("result" in obj) return obj.result;
    // A formula/sharedFormula cell with no cached result at all — happens
    // on the sheet's unused trailing template rows (formula like
    // `IF(ISBLANK(B44000), "", ...)` over an empty source cell, with no `<v>`
    // stored in the XML for ExcelJS to read). Treat as blank, not as data —
    // stringifying the descriptor object itself would otherwise read as a
    // truthy "name"/"date"/etc. and silently import thousands of phantom rows.
    if ("formula" in obj || "sharedFormula" in obj) return null;
  }
  return v;
}
function cellText(cell: Cell): string {
  const v = cellRaw(cell);
  return v === null || v === undefined ? "" : String(v).trim();
}
// Untrimmed — only used to detect the leading/trailing-whitespace name typos
// handled below (e.g. "Osui " vs "Osui"); every other use of a name wants
// cellText's trimmed version.
function cellTextRaw(cell: Cell): string {
  const v = cellRaw(cell);
  return v === null || v === undefined ? "" : String(v);
}
function cellNumber(cell: Cell): number | null {
  const v = cellRaw(cell);
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
function cellDate(cell: Cell): Date | null {
  const v = cellRaw(cell);
  return v instanceof Date ? v : null;
}
function unixSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

function sqlStr(v: string | null): string {
  if (v === null) return "NULL";
  return `'${v.replace(/'/g, "''")}'`;
}
function sqlNum(v: number | null): string {
  return v === null || !Number.isFinite(v) ? "NULL" : String(v);
}

// Verifies a worksheet's header row matches expectations at fixed column
// positions before trusting the columns below it — the sheet has already
// drifted once (GP Log's "Notes" column silently became the GP value
// column, not free text), so fail loud instead of importing garbage.
function assertHeaders(sheet: Worksheet, headerRow: number, expected: Record<number, string>) {
  const row = sheet.getRow(headerRow);
  const mismatches: string[] = [];
  for (const [colStr, want] of Object.entries(expected)) {
    const col = Number(colStr);
    const got = cellText(row.getCell(col));
    if (got.toLowerCase() !== want.toLowerCase()) {
      mismatches.push(`col ${col}: expected "${want}", got "${got}"`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `${sheet.name}: header row ${headerRow} doesn't match the expected shape — refusing to import garbage.\n` + mismatches.join("\n"),
    );
  }
}

// ---------- character class resolution ----------

const CLASS_BY_NAME = new Map(CHAR_CLASSES.map((c) => [c.name.toLowerCase(), c.id]));

// Classic EverQuest's automatic /who class title, awarded at 51/55/60 (this
// server caps at level 60 per MAX_CHAR_LEVEL, so there's no 65+ tier to
// worry about) — the sheet's "Class" column sometimes holds one of these
// instead of the base class name (e.g. "Virtuoso" for a level-60 Bard,
// "Assassin" for a level-60 Rogue), confirmed by direct inspection of both
// the Totals and EP Log tabs. Verified against two independent title
// references (bonzz.com/titles.htm, onlinegamecommands.com/everquest-class-
// titles) agreeing exactly on all three tiers before trusting this table —
// a wrong guess here is worse than leaving a character Unknown.
const CLASS_TITLES: Record<string, string[]> = {
  Warrior: ["Champion", "Myrmidon", "Warlord"],
  Cleric: ["Vicar", "Templar", "High Priest"],
  Paladin: ["Cavalier", "Knight", "Crusader"],
  Ranger: ["Pathfinder", "Outrider", "Warder"],
  "Shadow Knight": ["Reaver", "Revenant", "Grave Lord"],
  Druid: ["Wanderer", "Preserver", "Hierophant"],
  Monk: ["Disciple", "Master", "Grandmaster"],
  Bard: ["Minstrel", "Troubadour", "Virtuoso"],
  Rogue: ["Rake", "Blackguard", "Assassin"],
  Shaman: ["Mystic", "Luminary", "Oracle"],
  Necromancer: ["Heretic", "Defiler", "Warlock"],
  Wizard: ["Channeler", "Evoker", "Sorcerer"],
  Magician: ["Elementalist", "Conjurer", "Arch Mage"],
  Enchanter: ["Illusionist", "Beguiler", "Phantasmist"],
  Beastlord: ["Primalist", "Animist", "Savage Lord"],
};
const TITLE_TO_CLASS_NAME = new Map<string, string>();
for (const [className, titles] of Object.entries(CLASS_TITLES)) {
  for (const title of titles) TITLE_TO_CLASS_NAME.set(title.toLowerCase(), className);
}

// Only trust an exact base-class-name or known-title match; anything else
// resolves to UNKNOWN_CLASS_ID and is reported for manual review rather
// than silently mis-classified.
function resolveClassId(rawClass: string): number {
  const key = rawClass.toLowerCase();
  if (CLASS_BY_NAME.has(key)) return CLASS_BY_NAME.get(key)!;
  const titleClassName = TITLE_TO_CLASS_NAME.get(key);
  if (titleClassName) return CLASS_BY_NAME.get(titleClassName.toLowerCase())!;
  return UNKNOWN_CLASS_ID;
}

// ---------- static config (Point Values tab) ----------
//
// The "Point Values" tab is a hand-laid-out dashboard (two side-by-side
// blocks, decay % and free-text commentary sharing a column), not a clean
// header/row table — header-text column matching (used everywhere else in
// this script) doesn't apply to it safely. These values were read directly
// off the tab on 2026-08-18 and are transcribed here rather than parsed, to
// avoid a fragile position-based parser silently importing commentary rows
// as data. Re-verify against the sheet if the guild changes these.
const POINT_VALUES: { kind: "ep" | "gp"; activity: string; points: number; retired?: boolean }[] = [
  { kind: "ep", activity: "Raid - Start", points: 50 },
  { kind: "ep", activity: "Raid - Mid", points: 50 },
  { kind: "ep", activity: "Raid - End", points: 50 },
  { kind: "ep", activity: "New Target", points: 10 },
  { kind: "ep", activity: "Bank Donation", points: 10 },
  { kind: "ep", activity: "Event Lead", points: 10 },
  { kind: "ep", activity: "Event Attend", points: 50 },
  { kind: "ep", activity: "Hitting lvl 40", points: 20 },
  { kind: "ep", activity: "Hitting lvl 45", points: 40 },
  { kind: "ep", activity: "Hitting lvl 50", points: 60 },
  { kind: "ep", activity: "Hitting lvl 55", points: 80 },
  { kind: "ep", activity: "Hitting lvl 60", points: 100 },
  { kind: "ep", activity: "Guild Meeting", points: 50 },
  { kind: "ep", activity: "Epic Completion", points: 100 },
  { kind: "ep", activity: "Meeting (Retired)", points: 5, retired: true },
  { kind: "gp", activity: "Epic Drop (Main)", points: 0 },
  { kind: "gp", activity: "High Bid", points: 100 },
  { kind: "gp", activity: "Medium Bid", points: 50 },
  { kind: "gp", activity: "Low Bid", points: 10 },
  { kind: "gp", activity: "Epic Drop (Alt)", points: 0 },
  { kind: "gp", activity: "Alt Loot", points: 10 },
  { kind: "gp", activity: "Rot (No-Drop)", points: 10 },
  { kind: "gp", activity: "Main Swap Approval", points: 500 },
  { kind: "gp", activity: "Multi-SkyQuest High", points: 50 },
  { kind: "gp", activity: "Multi-SkyQuest Medium", points: 25 },
  { kind: "gp", activity: "Slight Upgrade (Retired)", points: 75, retired: true },
  { kind: "gp", activity: "SkyQuest Slight (Retired)", points: 37.25, retired: true },
  { kind: "gp", activity: "(Retired) Low Bid", points: 25, retired: true },
  { kind: "gp", activity: "Rot (Retired)", points: 25, retired: true },
  { kind: "gp", activity: "Alt Loot (Retired)", points: 150, retired: true },
  { kind: "gp", activity: "Lv 60 Alt Loot (Retired)", points: 100, retired: true },
  { kind: "gp", activity: "No Looter", points: 0 },
];

// What gets SEEDED into epgp_settings as the effective_from=0 baseline
// (PLAN.md §4i). base_ep/base_gp/ep_cap_per_cycle are straight off the
// Overview/Point Values tabs (2026-08-18). min_attendance/decay_model are
// website-only (not on the sheet — §4h/§1c). ep_decay/gp_decay were a sheet
// cell (historically 0.2) but the guild goes live on global cycle decay
// only — legacy §1a is never exercised past cutover — and voted the rate to
// 10%, so the seed is the post-cutover rule: 0.1 / "global". Keep
// src/lib/epgp/settings.ts DEFAULT_SETTINGS in sync with this.
const SETTINGS: Record<string, string> = {
  ep_decay: "0.1",
  gp_decay: "0.1",
  base_ep: "150",
  base_gp: "100",
  ep_cap_per_cycle: "900",
  min_attendance: "12",
  decay_model: "global",
};

// The sheet's Totals tab was computed with legacy §1a decay at 20%, so the
// reconciliation self-check below has to reproduce THOSE numbers to
// validate the import — it can't use SETTINGS (now global/10%) or every
// veteran would read as a mismatch. These are the sheet's own historical
// constants, used for nothing but that comparison.
const SHEET_RECON = { ep_decay: 0.2, gp_decay: 0.2, base_ep: 150, base_gp: 100 };

// ---------- main ----------

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(resolve(filePath!));

  const cyclesSheet = wb.getWorksheet("Cycles")!;
  const totalsSheet = wb.getWorksheet("Totals")!;
  const epSheet = wb.getWorksheet("EP Log")!;
  const gpSheet = wb.getWorksheet("GP Log")!;
  if (!cyclesSheet || !totalsSheet || !epSheet || !gpSheet) {
    throw new Error("Expected sheets Cycles, Totals, EP Log, GP Log were not all found in the workbook.");
  }

  // --- Cycles ---
  assertHeaders(cyclesSheet, 2, { 2: "Cycle Start", 3: "Cycle End", 4: "Cycle Number" });
  const cycles: { cycleNumber: number; start: Date; end: Date }[] = [];
  cyclesSheet.eachRow((row: Row, rowNumber: number) => {
    if (rowNumber < 3) return;
    const start = cellDate(row.getCell(2));
    const end = cellDate(row.getCell(3));
    const num = cellNumber(row.getCell(4));
    if (start && end && num !== null) cycles.push({ cycleNumber: num, start, end });
  });
  cycles.sort((a, b) => a.start.getTime() - b.start.getTime());
  console.log(`Cycles: ${cycles.length} parsed.`);

  function cycleForDate(date: Date): number | null {
    for (const c of cycles) {
      if (date >= c.start && date <= c.end) return c.cycleNumber;
    }
    // Open-ended fallback: the most recent cycle whose start is on/before
    // this date (covers rows dated after the sheet's last recorded cycle
    // end, which happens when Cycles lags EP/GP Log slightly).
    const candidates = cycles.filter((c) => c.start <= date);
    return candidates.length > 0 ? candidates[candidates.length - 1].cycleNumber : null;
  }

  // --- Totals: name -> class/level, and EP/GP for the reconciliation report ---
  assertHeaders(totalsSheet, 3, {
    3: "Name",
    4: "Class",
    5: "Level",
    6: "Effort Points",
    7: "Gear Points",
    8: "Loot Priority",
  });
  type CharRecord = { name: string; classId: number; level: number };
  const characters = new Map<string, CharRecord>(); // key: lowercased trimmed name
  const sheetTotals = new Map<string, { ep: number; gp: number; priority: number }>();

  totalsSheet.eachRow((row: Row, rowNumber: number) => {
    if (rowNumber < 4) return;
    const name = cellText(row.getCell(3));
    if (!name) return;
    const rawClass = cellText(row.getCell(4));
    const level = cellNumber(row.getCell(5)) ?? 1;
    const classId = resolveClassId(rawClass);
    characters.set(name.toLowerCase(), { name, classId, level });

    const ep = cellNumber(row.getCell(6));
    const gp = cellNumber(row.getCell(7));
    const priority = cellNumber(row.getCell(8));
    if (ep !== null && gp !== null && priority !== null) {
      sheetTotals.set(name.toLowerCase(), { ep, gp, priority });
    }
  });
  console.log(`Totals: ${characters.size} characters parsed.`);

  // Always returns the CANONICAL record for a name (first-seen casing) —
  // callers must use `.name` from the return value, not their own raw
  // string, when emitting SQL. `characters.name` is a case-sensitive unique
  // column, so a later row spelling the same character with different
  // casing (seen in the sheet, e.g. inconsistent capitalization between
  // Totals and the logs) would otherwise reference a name no `characters`
  // row actually has, leaving ep_ledger/gp_ledger.character_id NULL.
  function ensureCharacter(name: string): CharRecord {
    const key = name.toLowerCase();
    const existing = characters.get(key);
    if (existing) return existing;
    const created: CharRecord = { name, classId: UNKNOWN_CLASS_ID, level: 1 };
    characters.set(key, created);
    return created;
  }

  // The sheet's own Totals!F/G ("Effort Points"/"Gear Points") are computed
  // with SUMIF(Log!name, Totals!C, Log!points) — SUMIF is case-insensitive
  // but NOT whitespace-insensitive, so a log row like "Osui " (trailing
  // space) silently doesn't count toward Osui's total on the sheet, even
  // though it's obviously the same character. Confirmed 2026-08-19: the
  // guild's live sheet has 15 such rows across 11 characters. To match the
  // sheet's own numbers (the whole point of this importer) a log row with
  // leading/trailing whitespace that would otherwise match an *existing*
  // canonical name is excluded the same way, rather than silently folded in
  // — casing differences ("tuffums" vs "Tuffums") are still folded in, since
  // SUMIF itself treats those as equal.
  type SkippedNameRow = { sheet: string; row: number; raw: string; canonical: string; points: number | null };
  const skippedNameRows: SkippedNameRow[] = [];
  function resolveLogName(sheet: string, row: number, rawName: string, points: number | null): string | null {
    const trimmed = rawName.trim();
    if (!trimmed) return null;
    if (rawName !== trimmed) {
      const existing = characters.get(trimmed.toLowerCase());
      if (existing) {
        skippedNameRows.push({ sheet, row, raw: rawName, canonical: existing.name, points });
        return null;
      }
    }
    return ensureCharacter(trimmed).name;
  }

  // --- EP Log (cols M-X only — B-K is the sheet's raw-paste staging area, per the Instructions tab) ---
  assertHeaders(epSheet, 1, {
    13: "Cycle",
    14: "Date",
    15: "Name",
    16: "Class",
    17: "Level",
    18: "Point Type",
    20: "EP Points",
    22: "Points Earned",
  });
  type EpRow = {
    name: string | null; // null only when orphaned (see below)
    cycleNumber: number | null;
    occurredAt: Date;
    activity: string;
    points: number;
    nominalPoints: number;
    note: string | null;
    orphaned: boolean;
    key: string; // ep_ledger.source_key — a content hash, assigned after parsing
  };
  const epRows: EpRow[] = [];
  let epSkipped = 0;
  let epNameSkipped = 0;
  let epOrphaned = 0;
  // Every EP Log row also carries the character's class at that point in
  // time (col 16) — usually their real class, but "ANON" when that player
  // had privacy mode on for that entry. Totals!D (what seeds `characters`
  // above) is itself just that character's *most recent* EP Log row, so a
  // currently-ANON'd character shows Unknown there even though older rows
  // likely have their real class on file. Track the latest row per
  // character where the class actually resolves, and backfill with it
  // below — that way going ANON later doesn't erase a class we already
  // knew, and a class *title* (e.g. "Templar" for a lvl 60 Cleric) resolves
  // exactly like Totals' own class column does, via resolveClassId.
  type ClassSighting = { date: Date; classId: number };
  const classHistory = new Map<string, ClassSighting>(); // key: lowercased trimmed name
  epSheet.eachRow((row: Row, rowNumber: number) => {
    if (rowNumber < 2) return;
    const rawName = cellTextRaw(row.getCell(15));
    const trimmedName = rawName.trim();
    const date = cellDate(row.getCell(14));

    if (date && trimmedName) {
      const classId = resolveClassId(cellText(row.getCell(16)));
      if (classId !== UNKNOWN_CLASS_ID) {
        const key = trimmedName.toLowerCase();
        const existing = classHistory.get(key);
        if (!existing || date > existing.date) classHistory.set(key, { date, classId });
      }
    }

    const activity = cellText(row.getCell(18));
    const points = cellNumber(row.getCell(22)); // "Points Earned" (V) — awarded, cap already applied
    const nominalPoints = cellNumber(row.getCell(20)); // "EP Points" (T) — nominal, pre-cap (§2)
    const cycleNumber = cellNumber(row.getCell(13));
    const note = cellText(row.getCell(23)) || null;

    if (!trimmedName) {
      // Name stripped in the sheet before this site existed (§1e). Once the
      // name is blank, the "Points Earned" formula's dependency chain
      // breaks and the sheet has no cached numeric result for it at all
      // (verified directly: every one of the real 1,637 cases has date +
      // activity but a null Points Earned) — matching §1e's "Awarded value
      // computes to 0" finding exactly. Requires a real date + activity to
      // count as one of these rows at all, not one of the sheet's many
      // blank trailing template rows. Row is kept (orphaned), not dropped,
      // for audit completeness; contributes to no one's total
      // (character_id/player_id both NULL).
      if (!date || !activity) {
        epSkipped++;
        return;
      }
      epOrphaned++;
      const awarded = points ?? 0;
      epRows.push({ name: null, cycleNumber, occurredAt: date, activity, points: awarded, nominalPoints: nominalPoints ?? awarded, note, orphaned: true, key: "" });
      return;
    }

    if (!date || !activity || points === null) {
      epSkipped++;
      return;
    }
    const canonical = resolveLogName("EP Log", rowNumber, rawName, points);
    if (canonical === null) {
      epNameSkipped++;
      return;
    }
    epRows.push({ name: canonical, cycleNumber, occurredAt: date, activity, points, nominalPoints: nominalPoints ?? points, note, orphaned: false, key: "" });
  });
  let classBackfilled = 0;
  for (const [key, record] of characters) {
    if (record.classId !== UNKNOWN_CLASS_ID) continue;
    const sighting = classHistory.get(key);
    if (sighting) {
      record.classId = sighting.classId;
      classBackfilled++;
    }
  }
  console.log(`Class backfill: ${classBackfilled} character(s) resolved from an older EP Log row (Totals shows ANON/blank for them right now).`);
  console.log(
    `EP Log: ${epRows.length} rows parsed (${epOrphaned} orphaned — blank name, §1e), ${epSkipped} skipped (missing date/activity/points), ${epNameSkipped} skipped (whitespace name typo, doesn't match the sheet's SUMIF).`,
  );

  // --- GP Log ---
  // (col B "Key" is the sheet's own column — unused by us; source_key is a
  // content hash assigned after parsing, see below.)
  assertHeaders(gpSheet, 1, { 2: "Key", 3: "Date", 4: "Character", 5: "Loot", 6: "Gear Level", 7: "Notes", 8: "Duplicate Loot Found" });
  type GpRow = {
    name: string;
    occurredAt: Date;
    itemName: string | null;
    tier: string;
    points: number;
    duplicateFlag: boolean;
    key: string; // gp_ledger.source_key — a content hash, assigned after parsing
  };
  const gpRows: GpRow[] = [];
  let gpSkipped = 0;
  let gpUnresolvedCycle = 0;
  let gpNameSkipped = 0;
  gpSheet.eachRow((row: Row, rowNumber: number) => {
    if (rowNumber < 2) return;
    const rawName = cellTextRaw(row.getCell(4));
    if (!rawName.trim()) return;
    const date = cellDate(row.getCell(3));
    const tier = cellText(row.getCell(6));
    // "Notes" column holds the numeric GP value, not free text — confirmed
    // header/data mismatch, see docs/guild-website-feasibility.md §10 and
    // the EPGP plan's "Findings" §GP Log.
    const points = cellNumber(row.getCell(7));
    if (!date || !tier || points === null) {
      gpSkipped++;
      return;
    }
    const canonical = resolveLogName("GP Log", rowNumber, rawName, points);
    if (canonical === null) {
      gpNameSkipped++;
      return;
    }
    const itemName = cellText(row.getCell(5)) || null;
    const duplicateFlag = cellText(row.getCell(8)).toLowerCase() === "yes";
    if (cycleForDate(date) === null) gpUnresolvedCycle++;
    gpRows.push({ name: canonical, occurredAt: date, itemName, tier, points, duplicateFlag, key: "" });
  });

  // ---------- assign each ledger row a stable content-hash source_key ----------
  // Identity = the fields that make a row "the same entry" (name/date/
  // activity for EP; name/date/item for GP), plus a per-identity ordinal in
  // sheet order so genuinely repeated entries (two "Bank Donation" for one
  // person on one day, a duplicate drop) still get distinct keys. Mutable
  // fields (points, note, tier, cycle) are deliberately NOT in the key —
  // editing one keeps the key stable so --mode sync emits an UPDATE, not a
  // delete+insert. `HASH_SEP` between fields so "a|b" can't alias "ab|".
  const assignKeys = <T extends { key: string }>(rows: T[], identity: (r: T) => string) => {
    const seen = new Map<string, number>();
    for (const r of rows) {
      const id = identity(r);
      const ord = seen.get(id) ?? 0;
      seen.set(id, ord + 1);
      r.key = sha1(id + HASH_SEP + ord);
    }
    const distinct = new Set(rows.map((r) => r.key));
    if (distinct.size !== rows.length) {
      throw new Error(`source_key collision: ${rows.length - distinct.size} row(s) hashed to a non-unique key — should be impossible, investigate before applying.`);
    }
  };
  // EP identity includes `activity` (one person legitimately has Raid
  // Start/Mid/End on one date); GP identity stops at the item (`tier` is the
  // "how much", mutable like points — a tier correction should UPDATE, not
  // churn the row).
  assignKeys(epRows, (r) =>
    ["ep", r.name ?? "", unixSeconds(r.occurredAt), r.activity, r.orphaned ? "1" : "0"].join(HASH_SEP),
  );
  assignKeys(gpRows, (r) => ["gp", r.name, unixSeconds(r.occurredAt), r.itemName ?? ""].join(HASH_SEP));
  console.log(
    `GP Log: ${gpRows.length} rows parsed, ${gpSkipped} skipped, ${gpUnresolvedCycle} with no matching cycle date range, ${gpNameSkipped} skipped (whitespace name typo, doesn't match the sheet's SUMIF).`,
  );
  console.log(`Characters: ${characters.size} total (${characters.size - sheetTotals.size} GP/EP-only, not in Totals).`);
  if (skippedNameRows.length > 0) {
    const totalPoints = skippedNameRows.reduce((sum, r) => sum + (r.points ?? 0), 0);
    console.log(
      `\n${skippedNameRows.length} row(s) skipped for a whitespace name mismatch (${totalPoints} points not attributed to anyone — this matches the sheet's own SUMIF, but an officer trimming the name cell in the sheet would let a future re-import count it):`,
    );
    for (const r of skippedNameRows) console.log(`  ${r.sheet} row ${r.row}: "${r.raw}" (should be "${r.canonical}"), ${r.points ?? "?"} pts`);
  }

  // --- reconciliation report (computed here in JS, same formula as src/lib/epgp/totals.ts) ---
  // The Cycles tab is pre-populated with future cycles (through mid-November
  // 2026 as of this writing), so "current" has to be resolved the same way
  // totals.ts resolves it at query time: the cycle containing *now*, not
  // just the most recently started one.
  const now = new Date();
  const containingCycle = cycles.find((c) => now >= c.start && now <= c.end);
  const startedCycles = cycles.filter((c) => c.start <= now);
  const currentCycle = containingCycle ?? startedCycles[startedCycles.length - 1];
  const currentCycleStart = currentCycle?.start ?? new Date(0);
  console.log(`Reconciliation uses cycle ${currentCycle?.cycleNumber ?? "?"} (starts ${currentCycleStart.toISOString().slice(0, 10)}) as "current".`);
  const preEp = new Map<string, number>();
  const curEp = new Map<string, number>();
  for (const r of epRows) {
    if (r.orphaned) continue; // §1e — contributes to no one's total, nothing to reconcile against
    const key = r.name!.toLowerCase();
    const bucket = r.occurredAt < currentCycleStart ? preEp : curEp;
    bucket.set(key, (bucket.get(key) ?? 0) + r.points);
  }
  const preGp = new Map<string, number>();
  const curGp = new Map<string, number>();
  for (const r of gpRows) {
    const key = r.name.toLowerCase();
    const bucket = r.occurredAt < currentCycleStart ? preGp : curGp;
    bucket.set(key, (bucket.get(key) ?? 0) + r.points);
  }

  let matched = 0;
  const mismatches: string[] = [];
  for (const [key, sheet] of sheetTotals) {
    const preEpAmt = preEp.get(key) ?? 0;
    const preGpAmt = preGp.get(key) ?? 0;
    const rawEp = preEpAmt + (curEp.get(key) ?? 0);
    const rawGp = preGpAmt + (curGp.get(key) ?? 0);
    // Mirrors Totals!I/J's threshold guard: the sheet skips decay entirely
    // for a character whose raw lifetime total hasn't reached base_ep/gp
    // yet. Uses SHEET_RECON (legacy 20%), not SETTINGS — see its comment.
    const ep = rawEp - (rawEp < SHEET_RECON.base_ep ? 0 : preEpAmt * SHEET_RECON.ep_decay);
    const gp = rawGp - (rawGp < SHEET_RECON.base_gp ? 0 : preGpAmt * SHEET_RECON.gp_decay);
    if (Math.abs(ep - sheet.ep) <= 1 && Math.abs(gp - sheet.gp) <= 1) {
      matched++;
    } else {
      mismatches.push(`${characters.get(key)?.name ?? key}: computed EP ${ep.toFixed(1)} vs sheet ${sheet.ep}, GP ${gp.toFixed(1)} vs sheet ${sheet.gp}`);
    }
  }
  console.log(`\nReconciliation: ${matched}/${sheetTotals.size} characters match the sheet's Totals tab within ±1.`);
  if (mismatches.length > 0) {
    console.log(`${mismatches.length} did not match:`);
    for (const m of mismatches.slice(0, 40)) console.log(`  ${m}`);
    if (mismatches.length > 40) console.log(`  ...and ${mismatches.length - 40} more.`);
  }
  const stillUnresolvedClasses = [...characters.values()].filter((c) => c.classId === UNKNOWN_CLASS_ID);
  if (stillUnresolvedClasses.length > 0) {
    console.log(
      `\n${stillUnresolvedClasses.length} characters have no resolvable class anywhere in the EP Log (imported as Unknown, review in /admin):`,
    );
    for (const c of stillUnresolvedClasses.slice(0, 40)) console.log(`  ${c.name}`);
  }

  // ---------- read the target DB back (sync only) ----------
  // The one place this script touches D1: a single read query per table via
  // `wrangler d1 execute --json`, to work out which sheet rows are new /
  // edited / gone. All writes still go through the emitted .sql.
  function queryTarget(sql: string): Record<string, unknown>[] {
    const rawOut = execFileSync("npx", ["wrangler", "d1", "execute", "seekers-of-souls", d1Target, "--json", "--command", sql], {
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
    });
    const jsonStart = rawOut.indexOf("[");
    if (jsonStart === -1) throw new Error(`wrangler d1 execute returned no JSON:\n${rawOut.slice(0, 800)}`);
    const parsed = JSON.parse(rawOut.slice(jsonStart)) as { success?: boolean; results?: Record<string, unknown>[] }[];
    const first = parsed[0];
    if (!first?.success) throw new Error(`wrangler d1 execute failed:\n${rawOut.slice(0, 800)}`);
    return first.results ?? [];
  }

  // ---------- emit SQL ----------
  const out: string[] = [];
  out.push(`-- Generated by scripts/import-epgp.ts from ${filePath} on ${new Date().toISOString()}`);
  out.push(`-- mode=${mode}${mode === "sync" ? ` (diffed against ${remote ? "REMOTE" : "local"} D1)` : ""}`);
  out.push(`-- ${characters.size} characters, ${epRows.length} EP rows, ${gpRows.length} GP rows.`);

  if (wipe) {
    out.push("-- --mode reset: clear EPGP tables (characters/site accounts are untouched)");
    // bids.loot_event_id -> loot_events.id AND loot_events.winning_bid_id
    // -> bids.id is a genuine FK cycle (a loot event points at its winning
    // bid; a bid points at its parent loot event) — neither DELETE order
    // alone satisfies both directions. Null the back-reference first to
    // break the cycle, then delete children-before-parent as usual. Never
    // triggered until a DB actually had real bids/loot_events rows to
    // begin with (Phase 12+ live-bid submissions) and then got a --mode
    // reset run against it — caught 2026-09-05 re-importing over a
    // snapshot that did.
    out.push("UPDATE loot_events SET winning_bid_id = NULL;");
    out.push("DELETE FROM bids;");
    out.push("DELETE FROM loot_events;");
    out.push("DELETE FROM gp_ledger;");
    out.push("DELETE FROM ep_ledger;");
    out.push("DELETE FROM cycles;");
    // ledger_audit_log has no FK to ep_ledger/gp_ledger (a delete's audit
    // row must outlive the row it describes), so a wipe+reload leaves every
    // audit row pointing at a since-reassigned ledger id — stale, not
    // history. Clear it too. Real prod audit history is kept by never
    // running --mode reset against prod once live — that's --mode sync's job.
    out.push("DELETE FROM ledger_audit_log;");
  }
  // epgp_point_values is small, static, and fully derived from the sheet's
  // config tab — always safe to fully replace, --wipe or not.
  out.push("DELETE FROM epgp_point_values;");

  out.push("\n-- cycles");
  for (const c of cycles) {
    out.push(
      `INSERT OR IGNORE INTO cycles (cycle_number, start_date, end_date) VALUES (${c.cycleNumber}, ${unixSeconds(c.start)}, ${unixSeconds(c.end)});`,
    );
  }

  // Effective-dated (PLAN.md §4i) — there's no single row per key to
  // REPLACE anymore. Seeds the since-the-beginning-of-time baseline
  // (effective_from = 0) for a key ONLY if it has no row yet at all, so
  // re-running this importer can never silently revert a value the leader
  // has since tuned in the officer settings UI — it only fills a gap.
  out.push("\n-- epgp_settings baseline (idempotent: only inserts a key that has no row at all yet)");
  for (const [key, value] of Object.entries(SETTINGS)) {
    out.push(
      `INSERT INTO epgp_settings (setting_key, value, effective_from, changed_by, changed_at, note) SELECT ${sqlStr(key)}, ${sqlStr(value)}, 0, NULL, unixepoch(), 'seeded from xlsx import' WHERE NOT EXISTS (SELECT 1 FROM epgp_settings WHERE setting_key = ${sqlStr(key)});`,
    );
  }

  out.push("\n-- epgp_point_values");
  POINT_VALUES.forEach((pv, i) => {
    out.push(
      `INSERT INTO epgp_point_values (kind, activity, points, retired, sort_order) VALUES (${sqlStr(pv.kind)}, ${sqlStr(pv.activity)}, ${pv.points}, ${pv.retired ? 1 : 0}, ${i});`,
    );
  });

  out.push("\n-- characters (existing owned rows are left untouched — unique(name) + INSERT OR IGNORE)");
  for (const c of characters.values()) {
    out.push(
      `INSERT OR IGNORE INTO characters (owner_id, name, class, race, level, char_type, created_at, updated_at) VALUES (NULL, ${sqlStr(c.name)}, ${c.classId}, ${UNKNOWN_RACE_ID}, ${c.level}, 'main', unixepoch(), unixepoch());`,
    );
  }

  // Backfill class for characters imported by an earlier run that resolved
  // to Unknown then but resolve to a real class now (e.g. after extending
  // CLASS_TITLES) — INSERT OR IGNORE above is a no-op for rows that already
  // exist, so without this a rerun could never fix them. Scoped to
  // owner_id IS NULL (never touch a real site account's character) and
  // class = UNKNOWN_CLASS_ID (never downgrade or overwrite an already-
  // resolved/manually-set class).
  out.push("\n-- backfill: Unknown -> resolved class for previously-imported, still-unclaimed characters");
  for (const c of characters.values()) {
    if (c.classId === UNKNOWN_CLASS_ID) continue;
    out.push(
      `UPDATE characters SET class = ${c.classId}, updated_at = unixepoch() WHERE name = ${sqlStr(c.name)} AND owner_id IS NULL AND class = ${UNKNOWN_CLASS_ID};`,
    );
  }

  const BATCH = 300;

  // ---------- shared ledger SQL builders (both --mode reset and --mode sync) ----------
  const EP_COLS =
    "character_id, cycle_id, occurred_at, activity, points, points_nominal, points_awarded, cap_applied, cap_at_entry, orphaned, note, source, source_key";
  const GP_COLS =
    "character_id, cycle_id, occurred_at, item_name, tier, points, points_nominal, points_awarded, cap_applied, cap_at_entry, orphaned, duplicate_flag, source, source_key";
  const epCharIdExpr = (r: EpRow) => (r.orphaned ? "NULL" : `(SELECT id FROM characters WHERE name = ${sqlStr(r.name)})`);
  const epCycleIdExpr = (r: EpRow) =>
    r.cycleNumber !== null ? `(SELECT id FROM cycles WHERE cycle_number = ${r.cycleNumber})` : "NULL";
  const gpCycleIdExpr = (r: GpRow) => {
    const n = cycleForDate(r.occurredAt);
    return n !== null ? `(SELECT id FROM cycles WHERE cycle_number = ${n})` : "NULL";
  };
  const epCapApplied = (r: EpRow) => (r.nominalPoints !== r.points ? 1 : 0);
  const epTuple = (r: EpRow) =>
    `(${epCharIdExpr(r)}, ${epCycleIdExpr(r)}, ${unixSeconds(r.occurredAt)}, ${sqlStr(r.activity)}, ${sqlNum(r.points)}, ${sqlNum(r.nominalPoints)}, ${sqlNum(r.points)}, ${epCapApplied(r)}, ${sqlNum(Number(SETTINGS.ep_cap_per_cycle))}, ${r.orphaned ? 1 : 0}, ${sqlStr(r.note)}, 'import', ${sqlStr(r.key)})`;
  const gpTuple = (r: GpRow) =>
    `((SELECT id FROM characters WHERE name = ${sqlStr(r.name)}), ${gpCycleIdExpr(r)}, ${unixSeconds(r.occurredAt)}, ${sqlStr(r.itemName)}, ${sqlStr(r.tier)}, ${sqlNum(r.points)}, ${sqlNum(r.points)}, ${sqlNum(r.points)}, 0, NULL, 0, ${r.duplicateFlag ? 1 : 0}, 'import', ${sqlStr(r.key)})`;
  // Fingerprint = the mutable content of a row, on a basis the DB can report
  // back (character *name* via a join, cycle *number* via a lookup), so sync
  // can tell an unchanged row from an edited one. Fields are joined on U+0001,
  // a control char that can't occur in any sheet cell.
  const FP = "\u0001";
  const epFingerprint = (p: {
    name: string;
    cycleNumber: number | null;
    occurredAtUnix: number;
    activity: string;
    points: number | null;
    nominal: number | null;
    note: string | null;
    orphaned: boolean;
  }) => [p.name, p.cycleNumber ?? "", p.occurredAtUnix, p.activity, p.points ?? "", p.nominal ?? "", p.note ?? "", p.orphaned ? 1 : 0].join(FP);
  const gpFingerprint = (p: {
    name: string;
    occurredAtUnix: number;
    itemName: string | null;
    tier: string;
    points: number | null;
    dup: boolean;
  }) => [p.name, p.occurredAtUnix, p.itemName ?? "", p.tier, p.points ?? "", p.dup ? 1 : 0].join(FP);

  const insertBatched = (cols: string, tuples: string[], table: string) => {
    for (let i = 0; i < tuples.length; i += BATCH) {
      out.push(`INSERT INTO ${table} (${cols}) VALUES\n${tuples.slice(i, i + BATCH).join(",\n")};`);
    }
  };

  if (mode === "reset") {
    out.push("\n-- ep_ledger (full reload)");
    insertBatched(EP_COLS, epRows.map(epTuple), "ep_ledger");
    out.push("\n-- gp_ledger (full reload)");
    insertBatched(GP_COLS, gpRows.map(gpTuple), "gp_ledger");
  } else {
    // ---------- sync: diff the sheet against the current DB, emit only changes ----------
    // Guard: sync can only match rows that already carry a source_key. If the
    // target still holds import rows from a pre-source_key seed, a sync would
    // treat the entire sheet as "new" and double every ledger row.
    const [seedCheck] = queryTarget(
      "SELECT " +
        "(SELECT COUNT(*) FROM ep_ledger WHERE source='import') AS ep_import, " +
        "(SELECT COUNT(*) FROM ep_ledger WHERE source='import' AND source_key IS NOT NULL) AS ep_keyed, " +
        "(SELECT COUNT(*) FROM gp_ledger WHERE source='import') AS gp_import, " +
        "(SELECT COUNT(*) FROM gp_ledger WHERE source='import' AND source_key IS NOT NULL) AS gp_keyed",
    );
    const epImport = Number(seedCheck?.ep_import ?? 0);
    const gpImport = Number(seedCheck?.gp_import ?? 0);
    const epKeyed = Number(seedCheck?.ep_keyed ?? 0);
    const gpKeyed = Number(seedCheck?.gp_keyed ?? 0);
    if ((epImport > 0 && epKeyed === 0) || (gpImport > 0 && gpKeyed === 0)) {
      throw new Error(
        `The ${remote ? "remote" : "local"} DB has import ledger rows with no source_key ` +
          `(ep: ${epKeyed}/${epImport} keyed, gp: ${gpKeyed}/${gpImport}). Run \`--mode reset\` once against this target first, then sync.`,
      );
    }

    const cycleNumById = new Map<number, number>();
    for (const c of queryTarget("SELECT id, cycle_number FROM cycles")) {
      cycleNumById.set(Number(c.id), Number(c.cycle_number));
    }

    // EP
    const epDb = queryTarget(
      "SELECT el.source_key AS k, c.name AS name, el.cycle_id AS cycle_id, el.occurred_at AS occurred_at, " +
        "el.activity AS activity, el.points AS points, el.points_nominal AS nominal, el.note AS note, el.orphaned AS orphaned " +
        "FROM ep_ledger el LEFT JOIN characters c ON c.id = el.character_id " +
        "WHERE el.source = 'import' AND el.source_key IS NOT NULL",
    );
    const epDbFp = new Map<string, string>();
    for (const row of epDb) {
      epDbFp.set(
        String(row.k),
        epFingerprint({
          name: (row.name as string | null) ?? "",
          cycleNumber: row.cycle_id != null ? cycleNumById.get(Number(row.cycle_id)) ?? null : null,
          occurredAtUnix: Number(row.occurred_at),
          activity: (row.activity as string | null) ?? "",
          points: row.points == null ? null : Number(row.points),
          nominal: row.nominal == null ? null : Number(row.nominal),
          note: (row.note as string | null) ?? null,
          orphaned: !!row.orphaned,
        }),
      );
    }
    const epNew: EpRow[] = [];
    const epChanged: EpRow[] = [];
    const epSheetKeys = new Set<string>();
    for (const r of epRows) {
      const k = String(r.key);
      epSheetKeys.add(k);
      const sheetFp = epFingerprint({
        name: r.name ?? "",
        cycleNumber: r.cycleNumber,
        occurredAtUnix: unixSeconds(r.occurredAt),
        activity: r.activity,
        points: r.points,
        nominal: r.nominalPoints,
        note: r.note,
        orphaned: r.orphaned,
      });
      if (!epDbFp.has(k)) epNew.push(r);
      else if (epDbFp.get(k) !== sheetFp) epChanged.push(r);
    }
    const epRemoved = [...epDbFp.keys()].filter((k) => !epSheetKeys.has(k));

    out.push(`\n-- ep_ledger sync: +${epNew.length} new, ~${epChanged.length} changed, -${epRemoved.length} removed`);
    insertBatched(EP_COLS, epNew.map(epTuple), "ep_ledger");
    for (const r of epChanged) {
      // player_id nulled so the trailing backfill re-resolves it (covers a
      // name correction that moves the row to a different player).
      out.push(
        `UPDATE ep_ledger SET character_id = ${epCharIdExpr(r)}, cycle_id = ${epCycleIdExpr(r)}, occurred_at = ${unixSeconds(r.occurredAt)}, ` +
          `activity = ${sqlStr(r.activity)}, points = ${sqlNum(r.points)}, points_nominal = ${sqlNum(r.nominalPoints)}, points_awarded = ${sqlNum(r.points)}, ` +
          `cap_applied = ${epCapApplied(r)}, cap_at_entry = ${sqlNum(Number(SETTINGS.ep_cap_per_cycle))}, orphaned = ${r.orphaned ? 1 : 0}, ` +
          `note = ${sqlStr(r.note)}, player_id = NULL WHERE source_key = ${sqlStr(r.key)} AND source = 'import';`,
      );
    }
    for (const k of epRemoved) out.push(`DELETE FROM ep_ledger WHERE source_key = ${sqlStr(k)} AND source = 'import';`);

    // GP
    const gpDb = queryTarget(
      "SELECT gl.source_key AS k, c.name AS name, gl.occurred_at AS occurred_at, gl.item_name AS item_name, " +
        "gl.tier AS tier, gl.points AS points, gl.duplicate_flag AS duplicate_flag " +
        "FROM gp_ledger gl LEFT JOIN characters c ON c.id = gl.character_id " +
        "WHERE gl.source = 'import' AND gl.source_key IS NOT NULL",
    );
    const gpDbFp = new Map<string, string>();
    for (const row of gpDb) {
      gpDbFp.set(
        String(row.k),
        gpFingerprint({
          name: (row.name as string | null) ?? "",
          occurredAtUnix: Number(row.occurred_at),
          itemName: (row.item_name as string | null) ?? null,
          tier: (row.tier as string | null) ?? "",
          points: row.points == null ? null : Number(row.points),
          dup: !!row.duplicate_flag,
        }),
      );
    }
    const gpNew: GpRow[] = [];
    const gpChanged: GpRow[] = [];
    const gpSheetKeys = new Set<string>();
    for (const r of gpRows) {
      const k = String(r.key);
      gpSheetKeys.add(k);
      const sheetFp = gpFingerprint({
        name: r.name,
        occurredAtUnix: unixSeconds(r.occurredAt),
        itemName: r.itemName,
        tier: r.tier,
        points: r.points,
        dup: r.duplicateFlag,
      });
      if (!gpDbFp.has(k)) gpNew.push(r);
      else if (gpDbFp.get(k) !== sheetFp) gpChanged.push(r);
    }
    const gpRemoved = [...gpDbFp.keys()].filter((k) => !gpSheetKeys.has(k));

    out.push(`\n-- gp_ledger sync: +${gpNew.length} new, ~${gpChanged.length} changed, -${gpRemoved.length} removed`);
    insertBatched(GP_COLS, gpNew.map(gpTuple), "gp_ledger");
    for (const r of gpChanged) {
      out.push(
        `UPDATE gp_ledger SET character_id = (SELECT id FROM characters WHERE name = ${sqlStr(r.name)}), cycle_id = ${gpCycleIdExpr(r)}, ` +
          `occurred_at = ${unixSeconds(r.occurredAt)}, item_name = ${sqlStr(r.itemName)}, tier = ${sqlStr(r.tier)}, points = ${sqlNum(r.points)}, ` +
          `points_nominal = ${sqlNum(r.points)}, points_awarded = ${sqlNum(r.points)}, duplicate_flag = ${r.duplicateFlag ? 1 : 0}, ` +
          `player_id = NULL WHERE source_key = ${sqlStr(r.key)} AND source = 'import';`,
      );
    }
    for (const k of gpRemoved) out.push(`DELETE FROM gp_ledger WHERE source_key = ${sqlStr(k)} AND source = 'import';`);

    console.log(
      `\nSync plan vs ${remote ? "REMOTE" : "local"} D1 — EP: +${epNew.length} ~${epChanged.length} -${epRemoved.length}   GP: +${gpNew.length} ~${gpChanged.length} -${gpRemoved.length}` +
        `   (~${epNew.length + epChanged.length + epRemoved.length + gpNew.length + gpChanged.length + gpRemoved.length} ledger row writes)`,
    );
  }

  // ---------- fill ledger.player_id from characters.player_id ----------
  // computeEpgpTotals groups strictly by ledger player_id (no join), so a
  // freshly written row is invisible until this runs. Idempotent
  // (WHERE player_id IS NULL). On a fresh --mode reset this is a no-op at
  // apply time — characters.player_id isn't set until `derive:players` runs
  // — so re-run this file's tail (or `npm run derive:players -- --commit`
  // then re-apply) after that. In --mode sync the linkage already exists for
  // everyone but brand-new characters.
  out.push("\n-- backfill ledger.player_id from characters.player_id (idempotent)");
  out.push(
    "UPDATE ep_ledger SET player_id = (SELECT c.player_id FROM characters c WHERE c.id = ep_ledger.character_id) " +
      "WHERE source = 'import' AND player_id IS NULL AND character_id IS NOT NULL;",
  );
  out.push(
    "UPDATE gp_ledger SET player_id = (SELECT c.player_id FROM characters c WHERE c.id = gp_ledger.character_id) " +
      "WHERE source = 'import' AND player_id IS NULL AND character_id IS NOT NULL;",
  );

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, out.join("\n") + "\n");
  const rel = outPath.replace(process.cwd() + "/", "");
  console.log(`\nWrote ${rel} (${(out.join("\n").length / 1024 / 1024).toFixed(2)} MB).`);
  console.log(`Apply with: npx wrangler d1 execute seekers-of-souls ${d1Target} --file=${rel}`);
  if (mode === "sync") {
    console.log("Then re-check EP/GP totals against the sheet (npm run verify) before the next sync.");
  } else {
    console.log("Reset pipeline: apply -> import:sos-bot-dump -> derive:players --commit -> re-apply this file's player_id backfill -> backfill:expansion-decay -> verify.");
  }
}

if (!existsSync(resolve(filePath!))) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
