// PLAN.md §11 Phase 3 task 3.1 — load Toryn's sos_bot.characters dump into
// the sos_bot_staging table (src/db/schema.ts) for later derivation into
// players/characters (tasks 3.4+). See data/imports/sos-bot/README.md for
// the expected file location and shape.
//
// Accepts either a CSV export or a raw `mysqldump` .sql file straight off
// Toryn's `characters` table — the latter is what he actually sends (a full
// schema dump including several other tables from an abandoned parallel
// project; see the README). For .sql input, only the `characters` table's
// CREATE TABLE (for column order) and INSERT INTO ... VALUES rows are read;
// every other table in the dump is ignored.
//
// Truncates and reloads sos_bot_staging on every run, so a corrected dump
// can be re-imported without accumulating duplicates or requiring a flag.
// Never touches players/characters — that derivation is a separate,
// reviewable step, so a bad derivation can be redone without re-importing
// the dump.
//
// Usage:
//   npx tsx scripts/import-sos-bot-dump.ts --file data/imports/sos-bot/characters.csv
//   npx tsx scripts/import-sos-bot-dump.ts --file "data/imports/sos-bot/Dump20260823/sos_bot_characters.sql"
import { readFileSync } from "node:fs";

import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import * as schema from "../src/db";
import { sosBotStaging } from "../src/db/schema";

const getArg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

const REQUIRED_COLUMNS = ["discord_id", "char_name"] as const;
const KNOWN_COLUMNS = ["discord_id", "char_name", "char_race", "char_class", "char_type", "char_priority", "is_officer"] as const;

type Row = Record<string, string>;

// Minimal RFC 4180 CSV parser — handles quoted fields, embedded commas, and
// escaped quotes ("") within a quoted field. No external dependency: the
// expected shape (§14) is simple enough not to warrant one, and pulling in
// an undeclared transitive package (e.g. fast-csv, present only via
// exceljs) would be fragile.
function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      pushField();
    } else if (c === "\n") {
      pushRow();
    } else if (c === "\r") {
      // skip — the following \n handles the row break
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();

  const nonEmpty = rows.filter((r) => !(r.length === 1 && r[0] === ""));
  const [header, ...dataRows] = nonEmpty;
  if (!header) return [];
  return dataRows.map((cols) => {
    const obj: Row = {};
    header.forEach((h, idx) => {
      obj[h.trim()] = (cols[idx] ?? "").trim();
    });
    return obj;
  });
}

// Parses a mysqldump export, reading only the `characters` table: its
// CREATE TABLE (for column order — don't assume a fixed layout, since a
// future dump could reorder columns) and every `INSERT INTO `characters`
// VALUES ...;` statement (mysqldump splits very large tables across several).
// All other tables in the dump (members, ep_log, bids, respawns, ...) are
// ignored entirely — see the README.
function parseMysqlCharactersDump(text: string): Row[] {
  const createMatch = text.match(/CREATE TABLE `characters` \(([\s\S]*?)\n\)/);
  if (!createMatch) {
    throw new Error("Could not find `CREATE TABLE `characters`` in the dump — is this the right file?");
  }
  const columns: string[] = [];
  for (const line of createMatch[1].split("\n")) {
    const col = line.match(/^\s*`(\w+)`\s+\w/);
    if (col) columns.push(col[1]);
  }
  if (columns.length === 0) {
    throw new Error("Could not parse a column list from `characters`'s CREATE TABLE.");
  }

  const tuples: string[][] = [];
  const insertRe = /INSERT INTO `characters` VALUES\s*([\s\S]*?);/g;
  let m: RegExpExecArray | null;
  while ((m = insertRe.exec(text))) {
    tuples.push(...parseMysqlValueTuples(m[1]));
  }
  if (tuples.length === 0) {
    throw new Error("Found `characters`'s schema but no `INSERT INTO `characters` VALUES` rows in the dump.");
  }

  return tuples.map((values) => {
    const obj: Row = {};
    columns.forEach((col, idx) => {
      obj[col] = values[idx] ?? "";
    });
    return obj;
  });
}

// Parses a MySQL "(v1,v2,...),(v1,v2,...)" VALUES list (the body between
// `VALUES` and the closing `;`) into one string array per tuple, in column
// order. Handles quoted strings (backslash escapes and doubled '' quote
// escapes, mysqldump's default), bare NULL, and bare numeric literals.
// Unquoted NULL becomes "" in the result, same as an empty CSV field.
function parseMysqlValueTuples(text: string): string[][] {
  const tuples: string[][] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && text[i] !== "(") i++;
    if (i >= n) break;
    i++; // skip opening (
    const values: string[] = [];
    let field = "";
    let inQuotes = false;
    while (i < n) {
      const c = text[i];
      if (inQuotes) {
        if (c === "\\") {
          field += text[i + 1];
          i += 2;
          continue;
        }
        if (c === "'") {
          if (text[i + 1] === "'") {
            field += "'";
            i += 2;
            continue;
          }
          inQuotes = false;
          i++;
          continue;
        }
        field += c;
        i++;
        continue;
      }
      if (c === "'") {
        inQuotes = true;
        i++;
        continue;
      }
      if (c === ",") {
        values.push(field);
        field = "";
        i++;
        continue;
      }
      if (c === ")") {
        values.push(field);
        i++;
        break;
      }
      field += c;
      i++;
    }
    tuples.push(values.map((v) => (v === "NULL" ? "" : v)));
    while (i < n && text[i] !== "(") i++;
  }
  return tuples;
}

function toBool(v: string | undefined): boolean | null {
  if (v === undefined || v === "") return null;
  return v === "1" || v.toLowerCase() === "true";
}

function toInt(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

async function main() {
  const file = getArg("file");
  if (!file) {
    console.error("Usage: tsx scripts/import-sos-bot-dump.ts --file <path to .csv>");
    process.exit(1);
  }

  const text = readFileSync(file, "utf8");
  const isSql = /\.sql$/i.test(file);
  const records = isSql ? parseMysqlCharactersDump(text) : parseCsv(text);
  if (records.length === 0) {
    console.error(`No data rows found in the ${isSql ? "dump" : "CSV"}.`);
    process.exit(1);
  }

  const header = Object.keys(records[0]);
  const unknown = header.filter((h) => !(KNOWN_COLUMNS as readonly string[]).includes(h));
  if (unknown.length > 0) {
    console.warn(`Unrecognized column(s), ignored: ${unknown.join(", ")}`);
  }
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    console.error(`Missing required column(s): ${missing.join(", ")}`);
    process.exit(1);
  }

  const rows = records
    .filter((r) => r.discord_id && r.char_name)
    .map((r) => ({
      discordId: r.discord_id,
      charName: r.char_name,
      charRace: r.char_race || null,
      charClass: r.char_class || null,
      // Toryn's bot stores this Title Case ("Main"/"Alt"/"Mule") — normalize
      // to lowercase here so 3.4+'s derivation doesn't need to care which
      // source format (CSV vs. mysqldump) a given row came from.
      charType: r.char_type ? r.char_type.toLowerCase() : null,
      charPriority: toInt(r.char_priority),
      isOfficer: toBool(r.is_officer),
    }));

  const skipped = records.length - rows.length;
  if (skipped > 0) {
    console.warn(`Skipped ${skipped} row(s) missing discord_id or char_name.`);
  }

  const proxy = await getPlatformProxy({ configPath: "wrangler.jsonc" });
  try {
    const db = drizzle(proxy.env.DATABASE as unknown as Parameters<typeof drizzle>[0], { schema });

    await db.delete(sosBotStaging);
    // One row per insert rather than a batched multi-row VALUES: local D1
    // (Miniflare) hit "too many SQL variables" well under SQLite's nominal
    // 999-param limit even at small chunk sizes, and this is a one-time /
    // occasional import (a few hundred rows), not a hot path — not worth
    // chasing the actual limit.
    for (const row of rows) {
      await db.insert(sosBotStaging).values(row);
    }

    const distinctPlayers = new Set(rows.map((r) => r.discordId)).size;
    console.log(`Loaded ${rows.length} row(s) into sos_bot_staging (${distinctPlayers} distinct discord_id).`);
  } finally {
    await proxy.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
