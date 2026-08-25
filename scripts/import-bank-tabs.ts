// Converts the guild's "Spell Bank" and "Item Bank" sheet tabs into SQL
// seeding bank_holdings — see PLAN.md §3, §4f, §11 Phase 8 task 8.2.
//
// The sheet packs every physical stack a mule holds into one row with a
// comma-joined "Notes" column ("General6-Slot5, Bank1-Slot3, ..."). This
// splits that into bank_holdings' real shape: one row per physical stack.
// ("Sky Bank"/EmpVT/ST were a different problem, already handled by Phase
// 11's import-quest-flags.ts — not touched here.)
//
// Same non-destructive-by-default shape as import-epgp.ts /
// import-quest-flags.ts: this does NOT talk to D1 directly, it emits a
// reviewable .sql file. Assumes `characters` is already seeded for every
// *officer* named in the sheet (run import-epgp.ts / derive-players-from-
// sos-bot.ts first) — a mule name with no matching `characters` row is
// created here (char_type='mule', owned by the officer column's player),
// since mules are exactly the kind of character the EPGP importer never had
// a reason to create. An officer name with no match is reported and
// skipped, never guessed.
//
// Usage:
//   npx tsx scripts/import-bank-tabs.ts --file "/path/to/SoS - EPGP.xlsx" [--out drizzle/seed/bank-tabs-import.sql]
//   wrangler d1 execute seekers-of-souls --local --file=drizzle/seed/bank-tabs-import.sql
//
// Idempotent by construction, delete-and-replace **per holder character**,
// same as the schema's own design for a real Zeal-export import (§3/§4f):
// re-running deletes this script's own previously-written rows
// (`source = 'import' AND import_id IS NULL` — that `import_id IS NULL`
// clause is what keeps this scoped to sheet-migrated rows only, never a
// real inventory-export import's rows once task 8.4 starts writing those
// with a real bank_imports row) for every holder it's about to touch, then
// inserts the freshly parsed set. Safe to re-run after a fresh sheet
// export.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import ExcelJS from "exceljs";

import { UNKNOWN_CLASS_ID, UNKNOWN_RACE_ID } from "../src/lib/eq/enums";

type Cell = ExcelJS.Cell;
type Row = ExcelJS.Row;
type Worksheet = ExcelJS.Worksheet;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const filePath = arg("file");
if (!filePath) {
  console.error("Usage: tsx scripts/import-bank-tabs.ts --file <path to .xlsx> [--out <path>]");
  process.exit(1);
}
const outPath = resolve(arg("out") ?? "drizzle/seed/bank-tabs-import.sql");

// ---------- cell helpers (same shape as import-epgp.ts / import-quest-flags.ts) ----------

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
function cellNumber(cell: Cell): number {
  const v = cellRaw(cell);
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}
function sqlStr(v: string | null): string {
  if (v === null) return "NULL";
  return `'${v.replace(/'/g, "''")}'`;
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

// Bag containers/slots use "-" as separator in this sheet (Zeal exports can
// also use ":" — see the sibling pq-companion repo's inventoryLocations.ts,
// which this regex mirrors). A bare "Bank20" (no "-SlotN") means the item
// occupies the bag's own top-level slot, not something inside it —
// slotIndex 0, per bank_holdings' own schema comment.
const BAG_SLOT_RE = /^(General|Bank|SharedBank)(\d+)[:-]Slot(\d+)$/;
const BAG_CONTAINER_RE = /^(General|Bank|SharedBank)(\d+)$/;

type Loc = { container: string; slotIndex: number };

// Splits a raw "Notes" cell into recognized physical locations and leftover
// free text (restriction notes like "Main Only", "Can't Be Worn by IKS" —
// confirmed against the real sheet: no row mixes a real location token with
// a free-text one, so any non-location token here is a genuine note, not a
// mis-parsed location).
function parseNotes(raw: string): { locs: Loc[]; freeNotes: string[] } {
  const tokens = raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const locs: Loc[] = [];
  const freeNotes: string[] = [];
  for (const t of tokens) {
    const slot = t.match(BAG_SLOT_RE);
    if (slot) {
      locs.push({ container: `${slot[1]}${slot[2]}`, slotIndex: Number(slot[3]) });
      continue;
    }
    const bag = t.match(BAG_CONTAINER_RE);
    if (bag) {
      locs.push({ container: `${bag[1]}${bag[2]}`, slotIndex: 0 });
      continue;
    }
    freeNotes.push(t);
  }
  return { locs, freeNotes };
}

type HoldingRow = {
  holderName: string;
  officerName: string;
  category: "item" | "spell";
  itemName: string;
  container: string;
  slotIndex: number;
  quantity: number;
  classRestriction: string | null;
  status: "guild_bank" | "reserved";
  note: string | null;
};

// Splits one sheet row's (qty, locations) into one entry per physical
// stack. Verified against the real sheet before writing this: every
// Spell Bank row either has exactly one location (a stack) or exactly
// `qty` locations (one non-stacking item per slot) — never a partial
// mismatch. Item Bank has two rows (Flawless Diamond / Pristine Emerald,
// both qty 21 across 2 locations) that don't fit either pattern; those
// get a documented heuristic (stack cap 20, remainder on the last slot)
// rather than a guess buried in code — reported at the end of the run.
const STACK_CAP = 20;
function splitQuantity(locs: Loc[], qty: number): { loc: Loc; quantity: number }[] {
  if (locs.length === 0) return [];
  if (locs.length === 1) return [{ loc: locs[0], quantity: qty }];
  if (locs.length === qty) return locs.map((loc) => ({ loc, quantity: 1 }));
  // Neither pattern matches — heuristic split, stack-capped, remainder last.
  let remaining = qty;
  return locs.map((loc, i) => {
    const isLast = i === locs.length - 1;
    const quantity = isLast ? remaining : Math.min(STACK_CAP, remaining);
    remaining -= quantity;
    return { loc, quantity };
  });
}

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(resolve(filePath!));

  const spellSheet = wb.getWorksheet("Spell Bank");
  const itemSheet = wb.getWorksheet("Item Bank");
  if (!spellSheet || !itemSheet) {
    throw new Error('Expected sheets "Spell Bank", "Item Bank" were not both found in the workbook.');
  }

  assertHeaders(spellSheet, 2, { 2: "Officer", 3: "Mule", 4: "Spell", 5: "QTY", 6: "Class(es)", 7: "Notes" });
  assertHeaders(itemSheet, 2, { 2: "Lead/Officer", 3: "Mule/Loc", 4: "Item/Gear", 5: "QTY", 6: "Class", 7: "Status", 8: "Notes" });

  const rows: HoldingRow[] = [];
  const heuristicSplits: { holder: string; item: string; qty: number; locCount: number }[] = [];
  // Per-holder counter for rows with no recognizable location at all (blank
  // notes, or notes that are pure free text) — same idea as task 8.6's
  // "Manual" pseudo-container for officer-added rows, but "Sheet Import"
  // instead so the two provenances are never visually confused, and neither
  // string can ever collide with a real Zeal-export container (those are
  // always "General"/"Bank"/"SharedBank" + digits).
  const noLocCounters = new Map<string, number>();

  function nextNoLocSlot(holderName: string): number {
    const n = (noLocCounters.get(holderName) ?? 0) + 1;
    noLocCounters.set(holderName, n);
    return n;
  }

  // ---------- Spell Bank ----------
  let spellRowCount = 0;
  spellSheet.eachRow((row: Row, rowNumber: number) => {
    if (rowNumber <= 2) return;
    const itemName = cellText(row.getCell(4));
    if (!itemName) return;
    spellRowCount++;
    const officerName = cellText(row.getCell(2));
    const holderName = cellText(row.getCell(3)) || officerName;
    const qty = cellNumber(row.getCell(5));
    const classRestriction = cellText(row.getCell(6)) || null;
    const { locs, freeNotes } = parseNotes(cellText(row.getCell(7)));

    if (locs.length > 1 && locs.length !== qty) {
      heuristicSplits.push({ holder: holderName, item: itemName, qty, locCount: locs.length });
    }

    const splits = splitQuantity(locs, qty);
    if (splits.length === 0) {
      rows.push({
        holderName,
        officerName,
        category: "spell",
        itemName,
        container: "Sheet Import",
        slotIndex: nextNoLocSlot(holderName),
        quantity: qty,
        classRestriction,
        status: "guild_bank",
        note: freeNotes.length > 0 ? freeNotes.join("; ") : null,
      });
    } else {
      for (const s of splits) {
        rows.push({
          holderName,
          officerName,
          category: "spell",
          itemName,
          container: s.loc.container,
          slotIndex: s.loc.slotIndex,
          quantity: s.quantity,
          classRestriction,
          status: "guild_bank",
          note: freeNotes.length > 0 ? freeNotes.join("; ") : null,
        });
      }
    }
  });
  console.log(`Spell Bank: ${spellRowCount} sheet rows parsed.`);

  // ---------- Item Bank ----------
  let itemRowCount = 0;
  const statusCounts: Record<string, number> = {};
  itemSheet.eachRow((row: Row, rowNumber: number) => {
    if (rowNumber <= 2) return;
    const itemName = cellText(row.getCell(4));
    if (!itemName) return;
    itemRowCount++;
    const officerName = cellText(row.getCell(2));
    const holderName = cellText(row.getCell(3)) || officerName;
    const qty = cellNumber(row.getCell(5));
    const classRestriction = cellText(row.getCell(6)) || null;
    const statusRaw = cellText(row.getCell(7)).toLowerCase();
    // Blank status (32 of 78 rows) defaults to guild_bank — this tab is the
    // guild bank's own inventory by definition, and guild_bank is
    // bank_holdings' own schema default for exactly this reason.
    const status: "guild_bank" | "reserved" = statusRaw === "reserved" ? "reserved" : "guild_bank";
    statusCounts[statusRaw || "(blank)"] = (statusCounts[statusRaw || "(blank)"] ?? 0) + 1;
    const { locs, freeNotes } = parseNotes(cellText(row.getCell(8)));

    if (locs.length > 1 && locs.length !== qty) {
      heuristicSplits.push({ holder: holderName, item: itemName, qty, locCount: locs.length });
    }

    const splits = splitQuantity(locs, qty);
    if (splits.length === 0) {
      rows.push({
        holderName,
        officerName,
        category: "item",
        itemName,
        container: "Sheet Import",
        slotIndex: nextNoLocSlot(holderName),
        quantity: qty,
        classRestriction,
        status,
        note: freeNotes.length > 0 ? freeNotes.join("; ") : null,
      });
    } else {
      for (const s of splits) {
        rows.push({
          holderName,
          officerName,
          category: "item",
          itemName,
          container: s.loc.container,
          slotIndex: s.loc.slotIndex,
          quantity: s.quantity,
          classRestriction,
          status,
          note: freeNotes.length > 0 ? freeNotes.join("; ") : null,
        });
      }
    }
  });
  console.log(`Item Bank: ${itemRowCount} sheet rows parsed (status: ${JSON.stringify(statusCounts)}).`);
  console.log(`Total physical-stack rows after splitting: ${rows.length}.`);

  if (heuristicSplits.length > 0) {
    console.log(`\n${heuristicSplits.length} row(s) needed the stack-cap heuristic split (locations found ≠ QTY, more than one location):`);
    for (const h of heuristicSplits) {
      console.log(`  - ${h.holder} / ${h.item}: qty ${h.qty} across ${h.locCount} locations`);
    }
  }

  // ---------- Resolve holders: existing character, or a new mule ----------
  const holderNames = [...new Set(rows.map((r) => r.holderName))];
  // holderName -> officerName, for creating a missing mule. A holder can
  // only appear under one officer in this sheet (verified against the real
  // data before writing this) — if that ever stops being true, the first
  // officer seen wins and this is where to notice.
  const officerByHolder = new Map<string, string>();
  for (const r of rows) {
    if (!officerByHolder.has(r.holderName)) officerByHolder.set(r.holderName, r.officerName);
  }

  const out: string[] = [];
  out.push("-- Missing mule characters (holder names in Spell Bank/Item Bank with no existing `characters` row).");
  out.push("-- Owned by the officer column's player; race/class unknown (the sheet gives none), char_priority 2 per §4c.");
  for (const holderName of holderNames) {
    const officerName = officerByHolder.get(holderName)!;
    out.push(
      `INSERT INTO characters (player_id, name, class, race, level, char_type, char_priority)\n` +
        `SELECT player_id, ${sqlStr(holderName)}, ${UNKNOWN_CLASS_ID}, ${UNKNOWN_RACE_ID}, 1, 'mule', 2\n` +
        `FROM characters WHERE name = ${sqlStr(officerName)} COLLATE NOCASE\n` +
        `AND NOT EXISTS (SELECT 1 FROM characters WHERE name = ${sqlStr(holderName)} COLLATE NOCASE);`,
    );
  }

  out.push("\n-- Delete this script's own previously-imported rows for every holder it's about to touch.");
  out.push("-- Scoped to source='import' AND import_id IS NULL so a real Zeal-export import (task 8.4) is never touched.");
  for (const holderName of holderNames) {
    out.push(
      `DELETE FROM bank_holdings WHERE source = 'import' AND import_id IS NULL AND holder_character_id = ` +
        `(SELECT id FROM characters WHERE name = ${sqlStr(holderName)} COLLATE NOCASE);`,
    );
  }

  out.push("\n-- bank_holdings (Spell Bank + Item Bank tabs, PLAN.md §3/§4f/§11 Phase 8 task 8.2)");
  for (const r of rows) {
    out.push(
      `INSERT INTO bank_holdings (holder_character_id, category, container, slot_index, item_name, quantity, class_restriction, status, note, source, updated_at)\n` +
        `SELECT id, ${sqlStr(r.category)}, ${sqlStr(r.container)}, ${r.slotIndex}, ${sqlStr(r.itemName)}, ${r.quantity}, ${sqlStr(r.classRestriction)}, ${sqlStr(r.status)}, ${sqlStr(r.note)}, 'import', unixepoch()\n` +
        `FROM characters WHERE name = ${sqlStr(r.holderName)} COLLATE NOCASE;`,
    );
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, out.join("\n") + "\n");
  console.log(`\nWrote ${outPath}.`);
  console.log(`Apply with: wrangler d1 execute seekers-of-souls --local --file=${outPath.replace(process.cwd() + "/", "")}`);
  console.log(`\n${holderNames.length} distinct holder(s): ${holderNames.join(", ")}`);
}

if (!existsSync(resolve(filePath!))) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
