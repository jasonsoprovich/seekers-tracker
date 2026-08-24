// Converts the guild's "EmpVT Key List", "ST Key List", and "Sky Bank"
// sheet tabs into SQL seeding character_key_flags/sky_bank_rewards/
// sky_bank_stock — see PLAN.md §3, §4g, §11 Phase 11.
//
// Same non-destructive-by-default shape as import-epgp.ts: this does NOT
// talk to D1 directly, it emits a reviewable .sql file. Unlike that script,
// this one assumes `characters` is already seeded (run import-epgp.ts /
// derive-players-from-sos-bot.ts first) — a sheet row for a character this
// site has never heard of is reported and skipped, not created.
//
// Usage:
//   npx tsx scripts/import-quest-flags.ts --file "/path/to/SoS - EPGP.xlsx" [--out drizzle/seed/quest-flags-import.sql]
//   wrangler d1 execute seekers-of-souls --local --file=drizzle/seed/quest-flags-import.sql
//
// Idempotent by construction, no --wipe flag needed:
//  - character_key_flags: composite (character_id, flag_key) key, upserted
//    with `ON CONFLICT ... DO UPDATE ... WHERE source = 'import'` — re-
//    running always reflects the sheet's current state, but never clobbers
//    a future manual (officer-edited) row.
//  - sky_bank_rewards / sky_bank_stock: guild-wide reference catalogs with
//    no per-row provenance to protect, so every run deletes and reinserts
//    the whole table wholesale — same "always matches the sheet" idea as
//    bank_holdings' per-character delete-and-replace (§3), just at table
//    granularity since there's no holder character to scope it to.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import ExcelJS from "exceljs";

type Cell = ExcelJS.Cell;
type Row = ExcelJS.Row;
type Worksheet = ExcelJS.Worksheet;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const filePath = arg("file");
if (!filePath) {
  console.error("Usage: tsx scripts/import-quest-flags.ts --file <path to .xlsx> [--out <path>]");
  process.exit(1);
}
const outPath = resolve(arg("out") ?? "drizzle/seed/quest-flags-import.sql");

// ---------- cell helpers (same shape as import-epgp.ts) ----------

function cellRaw(cell: Cell): unknown {
  const v: unknown = cell.value;
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if ("result" in obj) return obj.result;
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
function sqlStr(v: string | null): string {
  if (v === null) return "NULL";
  return `'${v.replace(/'/g, "''")}'`;
}
function sqlNum(v: number | null): string {
  return v === null || !Number.isFinite(v) ? "NULL" : String(v);
}
function sqlBool(v: boolean): string {
  return v ? "1" : "0";
}
// A stable identifier from free text — used for ST's key-item names, which
// have no fixed catalog of their own (an officer just types the item name
// as it drops), unlike EmpVT's two fixed flags.
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

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
    throw new Error(`${sheet.name}: header row ${headerRow} doesn't match the expected shape — refusing to import garbage.\n` + mismatches.join("\n"));
  }
}

// EmpVT sometimes annotates an alt's row with its main in parens
// ("Ardivoli (Keikaku)") — confirmed 2026-08-24 against the real sheet:
// the base name before the paren is always the actual character (matches
// a real `characters` row), the parenthetical is just an informational
// note about whose alt it is, not part of the name.
function splitParenNote(raw: string): { name: string; note: string | null } {
  const m = raw.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (!m) return { name: raw, note: null };
  return { name: m[1].trim(), note: `Sheet listed as "${raw}"` };
}

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(resolve(filePath!));

  const empvtSheet = wb.getWorksheet("EmpVT Key List");
  const stSheet = wb.getWorksheet("ST Key List");
  const skyBankSheet = wb.getWorksheet("Sky Bank");
  if (!empvtSheet || !stSheet || !skyBankSheet) {
    throw new Error('Expected sheets "EmpVT Key List", "ST Key List", "Sky Bank" were not all found in the workbook.');
  }

  const out: string[] = [];

  // ---------- EmpVT Key List ----------
  assertHeaders(empvtSheet, 2, {
    2: "Name",
    3: "Class",
    4: "Emp Key?",
    5: "Unadorned VT Key?",
    6: "Logged By",
  });
  type KeyFlagRow = { name: string; note: string | null; flagKey: string; label: string; done: boolean; loggedBy: string | null };
  const empvtRows: KeyFlagRow[] = [];
  empvtSheet.eachRow((row: Row, rowNumber: number) => {
    if (rowNumber <= 2) return;
    const raw = cellText(row.getCell(2));
    if (!raw) return;
    const { name, note } = splitParenNote(raw);
    const loggedBy = cellText(row.getCell(6)) || null;
    const empDone = cellText(row.getCell(4)).toLowerCase().startsWith("yes");
    const vtDone = cellText(row.getCell(5)).toLowerCase().startsWith("yes");
    empvtRows.push({ name, note, flagKey: "empvt_emp", label: "Emperor of War Key", done: empDone, loggedBy });
    empvtRows.push({ name, note, flagKey: "empvt_vt", label: "Unadorned Vex Thal Key", done: vtDone, loggedBy });
  });
  console.log(`EmpVT Key List: ${empvtRows.length / 2} characters parsed.`);

  // ---------- ST Key List ----------
  assertHeaders(stSheet, 2, {
    2: "Name",
    3: "Class",
    4: "Key Item Recieved",
    5: "Turned in?",
    6: "Approved By",
  });
  const stRows: KeyFlagRow[] = [];
  stSheet.eachRow((row: Row, rowNumber: number) => {
    if (rowNumber <= 2) return;
    const raw = cellText(row.getCell(2));
    const itemName = cellText(row.getCell(4));
    if (!raw || !itemName) return;
    const { name, note } = splitParenNote(raw);
    const approvedBy = cellText(row.getCell(6)) || null;
    const done = cellText(row.getCell(5)).toLowerCase().startsWith("yes");
    stRows.push({ name, note, flagKey: `st_${slug(itemName)}`, label: itemName, done, loggedBy: approvedBy });
  });
  console.log(`ST Key List: ${stRows.length} key-item rows parsed.`);

  // ---------- character_key_flags ----------
  // Izgona-style re-logs (task 11.2 found one real duplicate: two EmpVT
  // rows for the same character/flag) OR-merge to "done" rather than
  // last-row-wins, so a genuine completion recorded on an earlier row can
  // never be un-done by a sparser later one.
  const merged = new Map<string, KeyFlagRow>(); // key: `${name.toLowerCase()}::${flagKey}`
  for (const r of [...empvtRows, ...stRows]) {
    const key = `${r.name.toLowerCase()}::${r.flagKey}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, r);
    } else {
      existing.done = existing.done || r.done;
      existing.loggedBy = existing.loggedBy ?? r.loggedBy;
      existing.note = existing.note ?? r.note;
    }
  }

  out.push("-- character_key_flags (EmpVT + ST, PLAN.md §11 Phase 11)");
  for (const r of merged.values()) {
    const charIdExpr = `(SELECT id FROM characters WHERE name = ${sqlStr(r.name)} COLLATE NOCASE)`;
    out.push(
      `INSERT INTO character_key_flags (character_id, category, flag_key, label, done, logged_by, note, source, updated_at)\n` +
        `SELECT id, ${sqlStr(r.flagKey.startsWith("st_") ? "st" : "empvt")}, ${sqlStr(r.flagKey)}, ${sqlStr(r.label)}, ${sqlBool(r.done)}, ${sqlStr(r.loggedBy)}, ${sqlStr(r.note)}, 'import', unixepoch()\n` +
        `FROM characters WHERE name = ${sqlStr(r.name)} COLLATE NOCASE\n` +
        `ON CONFLICT(character_id, flag_key) DO UPDATE SET\n` +
        `  done = excluded.done, logged_by = excluded.logged_by, note = excluded.note, updated_at = unixepoch()\n` +
        `WHERE character_key_flags.source = 'import';`,
    );
  }

  // ---------- Sky Bank: No-Drop reward catalog ----------
  assertHeaders(skyBankSheet, 2, {
    1: "Item Name",
    2: "Qty",
    4: "Item Name",
    5: "Qty",
    6: "Quest Name",
    7: "Class",
    8: "Item 2",
    9: "Item 3",
    10: "Item 4",
    11: "Officer Holding",
  });
  type RewardRow = {
    itemName: string;
    qty: number;
    questName: string;
    classRestriction: string | null;
    item2: string | null;
    item3: string | null;
    item4: string | null;
    officerHolding: string | null;
  };
  // itemName -> qty. Keyed/summed rather than pushed straight to a list —
  // the same item can occupy more than one physical stack in-game and
  // shows up as two rows for the same name (one real case: "Fire Sky
  // Ruby" x2); QTY becomes SUM() same as §3's bank-tab normalization.
  const stockByName = new Map<string, number>();
  // itemName -> reward. The right block has genuine duplicate rows too
  // (23 items appear 2-3 times, always with the identical quest name —
  // confirmed 2026-08-24, not two different quests coincidentally sharing
  // an item name) — a stray re-paste in the sheet, not real data. Last
  // occurrence wins: the later duplicate is consistently the more filled-
  // in one (e.g. Officer Holding set on a later row, blank on an earlier
  // one of the same item).
  const rewardsByName = new Map<string, RewardRow>();
  skyBankSheet.eachRow((row: Row, rowNumber: number) => {
    if (rowNumber <= 2) return;

    const stockName = cellText(row.getCell(1));
    if (stockName) stockByName.set(stockName, (stockByName.get(stockName) ?? 0) + (cellNumber(row.getCell(2)) ?? 0));

    const itemName = cellText(row.getCell(4));
    const questName = cellText(row.getCell(6));
    if (itemName && questName) {
      rewardsByName.set(itemName, {
        itemName,
        qty: cellNumber(row.getCell(5)) ?? 0,
        questName,
        classRestriction: cellText(row.getCell(7)) || null,
        item2: cellText(row.getCell(8)) || null,
        item3: cellText(row.getCell(9)) || null,
        item4: cellText(row.getCell(10)) || null,
        officerHolding: cellText(row.getCell(11)) || null,
      });
    }
  });
  console.log(`Sky Bank: ${stockByName.size} distinct stock items, ${rewardsByName.size} distinct No-Drop reward items parsed.`);

  out.push("\n-- sky_bank_stock (Sky Bank tab, left Item Name/Qty block — whole-table refresh)");
  out.push("DELETE FROM sky_bank_stock;");
  for (const [itemName, qty] of stockByName) {
    out.push(`INSERT INTO sky_bank_stock (item_name, qty, updated_at) VALUES (${sqlStr(itemName)}, ${sqlNum(qty)}, unixepoch());`);
  }

  out.push("\n-- sky_bank_rewards (Sky Bank tab, No-Drop reward catalog — whole-table refresh)");
  out.push("DELETE FROM sky_bank_rewards;");
  for (const r of rewardsByName.values()) {
    out.push(
      `INSERT INTO sky_bank_rewards (item_name, qty, quest_name, class_restriction, item2_status, item3_status, item4_status, officer_holding, updated_at) VALUES (${sqlStr(r.itemName)}, ${sqlNum(r.qty)}, ${sqlStr(r.questName)}, ${sqlStr(r.classRestriction)}, ${sqlStr(r.item2)}, ${sqlStr(r.item3)}, ${sqlStr(r.item4)}, ${sqlStr(r.officerHolding)}, unixepoch());`,
    );
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, out.join("\n") + "\n");
  console.log(`\nWrote ${outPath}.`);
  console.log(`Apply with: wrangler d1 execute seekers-of-souls --local --file=${outPath.replace(process.cwd() + "/", "")}`);
  console.log(
    "\nNote: rows for a name with no matching `characters` row are silently skipped by the SELECT-based INSERT " +
      "(no `character_id`/`orphaned` concept here, unlike ep_ledger/gp_ledger) — re-run npm run verify:quest-flags " +
      "after applying to see exactly which sheet rows didn't land.",
  );
}

if (!existsSync(resolve(filePath!))) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
