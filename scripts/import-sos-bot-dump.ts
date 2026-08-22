// PLAN.md §11 Phase 3 task 3.1 — load Toryn's sos_bot.characters dump into
// the sos_bot_staging table (src/db/schema.ts) for later derivation into
// players/characters (tasks 3.4+). See data/imports/sos-bot/README.md for
// the expected file location and CSV shape.
//
// Truncates and reloads sos_bot_staging on every run, so a corrected dump
// can be re-imported without accumulating duplicates or requiring a flag.
// Never touches players/characters — that derivation is a separate,
// reviewable step, so a bad derivation can be redone without re-importing
// the dump.
//
// Usage:
//   npx tsx scripts/import-sos-bot-dump.ts --file data/imports/sos-bot/characters.csv
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
  const records = parseCsv(text);
  if (records.length === 0) {
    console.error("No data rows found in the CSV.");
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
      charType: r.char_type || null,
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
    if (rows.length > 0) {
      // D1/SQLite bind-parameter limit — chunk the insert.
      const CHUNK = 200;
      for (let i = 0; i < rows.length; i += CHUNK) {
        await db.insert(sosBotStaging).values(rows.slice(i, i + CHUNK));
      }
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
