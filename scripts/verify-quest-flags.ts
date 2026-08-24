// PLAN.md §11 Phase 11 task 11.2 — reconciliation report for
// import-quest-flags.ts. That script emits SQL with SELECT-based INSERTs
// (`INSERT INTO character_key_flags (...) SELECT ... FROM characters WHERE
// name = X`), which silently no-ops for any sheet row whose name doesn't
// match an existing `characters` row — there's no `orphaned` flag to catch
// this the way ep_ledger/gp_ledger have one. This re-parses the same sheet
// tabs, resolves names against live local D1 the same case-insensitive way
// the import SQL does, and reports exactly which rows didn't land.
//
// Read-only report, always exits 0 — a name genuinely absent from the
// roster (a departed/renamed member, a typo, a joke entry like the sheet's
// own "Testcharacter") is expected, not a bug; it's here so an officer can
// glance at the list rather than the row simply vanishing unexplained.
//
// Usage:
//   npx tsx scripts/verify-quest-flags.ts --file "/path/to/SoS - EPGP.xlsx"
import { resolve } from "node:path";

import ExcelJS from "exceljs";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import * as schema from "../src/db";
import { characters, characterKeyFlags, skyBankRewards, skyBankStock } from "../src/db/schema";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const filePath = arg("file");
if (!filePath) {
  console.error("Usage: tsx scripts/verify-quest-flags.ts --file <path to .xlsx>");
  process.exit(1);
}

function cellRaw(cell: ExcelJS.Cell): unknown {
  const v: unknown = cell.value;
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if ("result" in obj) return obj.result;
    if ("formula" in obj || "sharedFormula" in obj) return null;
  }
  return v;
}
function cellText(cell: ExcelJS.Cell): string {
  const v = cellRaw(cell);
  return v === null || v === undefined ? "" : String(v).trim();
}
function baseName(raw: string): string {
  const m = raw.match(/^(.*?)\s*\([^)]+\)\s*$/);
  return (m ? m[1] : raw).trim();
}

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(resolve(filePath!));
  const empvtSheet = wb.getWorksheet("EmpVT Key List")!;
  const stSheet = wb.getWorksheet("ST Key List")!;
  const skyBankSheet = wb.getWorksheet("Sky Bank")!;

  const sheetNames = new Map<string, { sheet: string; row: number }[]>();
  function record(name: string, sheet: string, row: number) {
    const key = name.toLowerCase();
    if (!sheetNames.has(key)) sheetNames.set(key, []);
    sheetNames.get(key)!.push({ sheet, row });
  }
  empvtSheet.eachRow((row, rn) => {
    if (rn <= 2) return;
    const raw = cellText(row.getCell(2));
    if (raw) record(baseName(raw), "EmpVT Key List", rn);
  });
  stSheet.eachRow((row, rn) => {
    if (rn <= 2) return;
    const raw = cellText(row.getCell(2));
    const item = cellText(row.getCell(4));
    if (raw && item) record(baseName(raw), "ST Key List", rn);
  });

  let stockRows = 0;
  let rewardRows = 0;
  skyBankSheet.eachRow((row, rn) => {
    if (rn <= 2) return;
    if (cellText(row.getCell(1))) stockRows++;
    if (cellText(row.getCell(4)) && cellText(row.getCell(6))) rewardRows++;
  });

  const proxy = await getPlatformProxy({ configPath: "wrangler.jsonc" });
  try {
    const db = drizzle(proxy.env.DATABASE as unknown as Parameters<typeof drizzle>[0], { schema });

    const allCharacters = await db.select({ name: characters.name }).from(characters);
    const knownNames = new Set(allCharacters.map((c) => c.name.toLowerCase()));

    const unmatched: { name: string; sheet: string; row: number }[] = [];
    for (const [key, occurrences] of sheetNames) {
      if (!knownNames.has(key)) {
        for (const o of occurrences) unmatched.push({ name: key, sheet: o.sheet, row: o.row });
      }
    }

    console.log(`Sheet: ${sheetNames.size} distinct character names across EmpVT/ST, ${stockRows} Sky Bank stock rows, ${rewardRows} Sky Bank reward rows.`);

    const [flagCount, rewardCount, stockCount] = await Promise.all([
      db.$count(characterKeyFlags),
      db.$count(skyBankRewards),
      db.$count(skyBankStock),
    ]);
    console.log(`DB: ${flagCount} character_key_flags rows, ${rewardCount} sky_bank_rewards rows, ${stockCount} sky_bank_stock rows.`);

    if (unmatched.length === 0) {
      console.log("\nEvery EmpVT/ST sheet name matched a real `characters` row.");
    } else {
      console.log(`\n${unmatched.length} sheet row(s) reference a name with no matching \`characters\` row (silently skipped by the import):`);
      for (const u of unmatched) console.log(`  ${u.sheet} row ${u.row}: "${u.name}"`);
    }
  } finally {
    await proxy.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
