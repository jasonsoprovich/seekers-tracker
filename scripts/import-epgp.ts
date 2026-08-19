// Converts the guild's hand-maintained EPGP Google Sheet (downloaded as
// .xlsx) into SQL that seeds ep_ledger/gp_ledger/cycles/epgp_* — see
// docs/guild-website-feasibility.md and the EPGP plan for background.
//
// This does NOT talk to D1 directly: it emits a .sql file you apply with
// `wrangler d1 execute`, so a re-snapshot before go-live is one review-able
// diff, not a live write from a dev machine.
//
// Usage:
//   npx tsx scripts/import-epgp.ts --file "/path/to/SoS - EPGP.xlsx" [--out drizzle/seed/epgp-import.sql] [--wipe]
//   wrangler d1 execute seekers-of-souls --local --file=drizzle/seed/epgp-import.sql
//
// --wipe prepends DELETEs for the EPGP ledger/config tables (NOT
// `characters` — real site accounts and previously-imported roster rows are
// preserved; `characters` has a unique name constraint and every insert
// here is `INSERT OR IGNORE`, so reruns are naturally idempotent for it).
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
  console.error("Usage: tsx scripts/import-epgp.ts --file <path to .xlsx> [--out <path>] [--wipe]");
  process.exit(1);
}
const outPath = resolve(arg("out") ?? "drizzle/seed/epgp-import.sql");
const wipe = hasFlag("wipe");

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

// The sheet's "Class" columns sometimes hold the base class name (matches
// CHAR_CLASSES directly) and sometimes hold a level-title (e.g. "Virtuoso"
// for a level-60 Bard, "Assassin" for a level-60 Rogue) — confirmed by
// direct inspection of both the Totals and EP Log tabs. There is no
// authoritative title->class table available to consult without risking a
// wrong guess, so: only trust an exact base-class-name match; anything else
// resolves to UNKNOWN_CLASS_ID and is reported for manual review rather
// than silently mis-classified.
function resolveClassId(rawClass: string): number {
  return CLASS_BY_NAME.get(rawClass.toLowerCase()) ?? UNKNOWN_CLASS_ID;
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

// Base EP/GP, decay %, and the per-cycle EP cap, read directly off the
// Overview/Point Values tabs on 2026-08-18. src/lib/epgp/totals.ts falls
// back to these same numbers if this table is ever empty, so they're
// duplicated here deliberately, not derived from one shared source.
const SETTINGS: Record<string, number> = {
  ep_decay: 0.2,
  gp_decay: 0.2,
  base_ep: 150,
  base_gp: 100,
  ep_cap_per_cycle: 900,
  min_ep: 0,
};

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
  const unresolvedClasses = new Set<string>();
  const sheetTotals = new Map<string, { ep: number; gp: number; priority: number }>();

  totalsSheet.eachRow((row: Row, rowNumber: number) => {
    if (rowNumber < 4) return;
    const name = cellText(row.getCell(3));
    if (!name) return;
    const rawClass = cellText(row.getCell(4));
    const level = cellNumber(row.getCell(5)) ?? 1;
    const classId = resolveClassId(rawClass);
    if (classId === UNKNOWN_CLASS_ID && rawClass) unresolvedClasses.add(`${name} (sheet says "${rawClass}")`);
    characters.set(name.toLowerCase(), { name, classId, level });

    const ep = cellNumber(row.getCell(6));
    const gp = cellNumber(row.getCell(7));
    const priority = cellNumber(row.getCell(8));
    if (ep !== null && gp !== null && priority !== null) {
      sheetTotals.set(name.toLowerCase(), { ep, gp, priority });
    }
  });
  console.log(`Totals: ${characters.size} characters, ${unresolvedClasses.size} with an unresolvable class title.`);

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

  // --- EP Log (cols M-X only — B-K is the sheet's raw-paste staging area, per the Instructions tab) ---
  assertHeaders(epSheet, 1, {
    13: "Cycle",
    14: "Date",
    15: "Name",
    17: "Level",
    18: "Point Type",
    20: "EP Points",
    22: "Points Earned",
  });
  type EpRow = { name: string; cycleNumber: number | null; occurredAt: Date; activity: string; points: number; note: string | null };
  const epRows: EpRow[] = [];
  let epSkipped = 0;
  epSheet.eachRow((row: Row, rowNumber: number) => {
    if (rowNumber < 2) return;
    const name = cellText(row.getCell(15));
    if (!name) return;
    const date = cellDate(row.getCell(14));
    const activity = cellText(row.getCell(18));
    const points = cellNumber(row.getCell(22)); // "Points Earned" — cap already applied, see plan §Findings 3
    if (!date || !activity || points === null) {
      epSkipped++;
      return;
    }
    const canonical = ensureCharacter(name).name;
    const cycleNumber = cellNumber(row.getCell(13));
    const note = cellText(row.getCell(23)) || null;
    epRows.push({ name: canonical, cycleNumber, occurredAt: date, activity, points, note });
  });
  console.log(`EP Log: ${epRows.length} rows parsed, ${epSkipped} skipped (missing date/activity/points).`);

  // --- GP Log ---
  assertHeaders(gpSheet, 1, { 2: "Key", 3: "Date", 4: "Character", 5: "Loot", 6: "Gear Level", 7: "Notes", 8: "Duplicate Loot Found" });
  type GpRow = {
    name: string;
    occurredAt: Date;
    itemName: string | null;
    tier: string;
    points: number;
    duplicateFlag: boolean;
  };
  const gpRows: GpRow[] = [];
  let gpSkipped = 0;
  let gpUnresolvedCycle = 0;
  gpSheet.eachRow((row: Row, rowNumber: number) => {
    if (rowNumber < 2) return;
    const name = cellText(row.getCell(4));
    if (!name) return;
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
    const canonical = ensureCharacter(name).name;
    const itemName = cellText(row.getCell(5)) || null;
    const duplicateFlag = cellText(row.getCell(8)).toLowerCase() === "yes";
    if (cycleForDate(date) === null) gpUnresolvedCycle++;
    gpRows.push({ name: canonical, occurredAt: date, itemName, tier, points, duplicateFlag });
  });
  console.log(`GP Log: ${gpRows.length} rows parsed, ${gpSkipped} skipped, ${gpUnresolvedCycle} with no matching cycle date range.`);
  console.log(`Characters: ${characters.size} total (${characters.size - sheetTotals.size} GP/EP-only, not in Totals).`);

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
    const key = r.name.toLowerCase();
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
    const ep = (preEp.get(key) ?? 0) * (1 - SETTINGS.ep_decay) + (curEp.get(key) ?? 0);
    const gp = (preGp.get(key) ?? 0) * (1 - SETTINGS.gp_decay) + (curGp.get(key) ?? 0);
    if (Math.abs(ep - sheet.ep) <= 1 && Math.abs(gp - sheet.gp) <= 1) {
      matched++;
    } else {
      mismatches.push(`${characters.get(key)?.name ?? key}: computed EP ${ep.toFixed(1)} vs sheet ${sheet.ep}, GP ${gp.toFixed(1)} vs sheet ${sheet.gp}`);
    }
  }
  console.log(`\nReconciliation: ${matched}/${sheetTotals.size} characters match the sheet's Totals tab within ±1.`);
  if (mismatches.length > 0) {
    console.log(`${mismatches.length} did not match (known: ~28 characters have sheet-side decay of 0 for unclear reasons — see plan's "Open questions"):`);
    for (const m of mismatches.slice(0, 40)) console.log(`  ${m}`);
    if (mismatches.length > 40) console.log(`  ...and ${mismatches.length - 40} more.`);
  }
  if (unresolvedClasses.size > 0) {
    console.log(`\n${unresolvedClasses.size} characters have a class title the importer won't guess (imported as Unknown, review in /admin):`);
    for (const c of Array.from(unresolvedClasses).slice(0, 40)) console.log(`  ${c}`);
  }

  // ---------- emit SQL ----------
  const out: string[] = [];
  out.push(`-- Generated by scripts/import-epgp.ts from ${filePath} on ${new Date().toISOString()}`);
  out.push(`-- ${characters.size} characters, ${epRows.length} EP rows, ${gpRows.length} GP rows.`);

  if (wipe) {
    out.push("-- --wipe: clear EPGP tables (characters/site accounts are untouched)");
    out.push("DELETE FROM bids;");
    out.push("DELETE FROM loot_events;");
    out.push("DELETE FROM gp_ledger;");
    out.push("DELETE FROM ep_ledger;");
    out.push("DELETE FROM cycles;");
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

  out.push("\n-- epgp_settings (INSERT OR REPLACE — leadership may have already tuned these in the app; re-running the importer intentionally resets them to the sheet's last-known values)");
  for (const [key, value] of Object.entries(SETTINGS)) {
    out.push(`INSERT OR REPLACE INTO epgp_settings (key, value, updated_at) VALUES (${sqlStr(key)}, ${sqlStr(String(value))}, unixepoch());`);
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

  const BATCH = 300;
  out.push("\n-- ep_ledger");
  for (let i = 0; i < epRows.length; i += BATCH) {
    const batch = epRows.slice(i, i + BATCH);
    const values = batch
      .map((r) => {
        const cycleIdExpr = r.cycleNumber !== null ? `(SELECT id FROM cycles WHERE cycle_number = ${r.cycleNumber})` : "NULL";
        const charIdExpr = `(SELECT id FROM characters WHERE name = ${sqlStr(r.name)})`;
        return `(${charIdExpr}, ${cycleIdExpr}, ${unixSeconds(r.occurredAt)}, ${sqlStr(r.activity)}, ${sqlNum(r.points)}, ${sqlStr(r.note)}, 'import')`;
      })
      .join(",\n");
    out.push(`INSERT INTO ep_ledger (character_id, cycle_id, occurred_at, activity, points, note, source) VALUES\n${values};`);
  }

  out.push("\n-- gp_ledger");
  for (let i = 0; i < gpRows.length; i += BATCH) {
    const batch = gpRows.slice(i, i + BATCH);
    const values = batch
      .map((r) => {
        const cycleNum = cycleForDate(r.occurredAt);
        const cycleIdExpr = cycleNum !== null ? `(SELECT id FROM cycles WHERE cycle_number = ${cycleNum})` : "NULL";
        const charIdExpr = `(SELECT id FROM characters WHERE name = ${sqlStr(r.name)})`;
        return `(${charIdExpr}, ${cycleIdExpr}, ${unixSeconds(r.occurredAt)}, ${sqlStr(r.itemName)}, ${sqlStr(r.tier)}, ${sqlNum(r.points)}, ${r.duplicateFlag ? 1 : 0}, 'import')`;
      })
      .join(",\n");
    out.push(
      `INSERT INTO gp_ledger (character_id, cycle_id, occurred_at, item_name, tier, points, duplicate_flag, source) VALUES\n${values};`,
    );
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, out.join("\n") + "\n");
  console.log(`\nWrote ${outPath} (${(out.join("\n").length / 1024 / 1024).toFixed(1)} MB).`);
  console.log(`Apply with: wrangler d1 execute seekers-of-souls --local --file=${outPath.replace(process.cwd() + "/", "")}`);
}

if (!existsSync(resolve(filePath!))) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
