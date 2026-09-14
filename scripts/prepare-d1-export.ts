// Reorder a Cloudflare D1 SQL export for import into a fresh D1 database.
// D1 exports table rows immediately after each CREATE TABLE, which fails when
// those rows reference a table that appears later in the dump. Creating every
// table first lets the export's deferred foreign keys handle those references.
import { readFileSync, writeFileSync } from "node:fs";

function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | "`" | null = null;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    if (quote) {
      if (char === quote) {
        if (sql[i + 1] === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (char === ";") {
      const statement = sql.slice(start, i + 1).trim();
      if (statement) statements.push(statement);
      start = i + 1;
    }
  }
  const trailing = sql.slice(start).trim();
  if (trailing) throw new Error("D1 export ended with an unterminated SQL statement");
  if (quote) throw new Error("D1 export ended inside a quoted value");
  return statements;
}

export function prepareD1Export(sql: string): string {
  const tables: string[] = [];
  const data: string[] = [];
  const schemaAfterData: string[] = [];

  for (const statement of splitStatements(sql)) {
    const normalized = statement.trimStart().toUpperCase();
    if (normalized.startsWith("PRAGMA ")) continue;
    if (normalized.startsWith("CREATE TABLE ")) tables.push(statement);
    else if (normalized.startsWith("INSERT INTO ") || normalized.startsWith("DELETE FROM ")) data.push(statement);
    else if (normalized.startsWith("CREATE INDEX ") || normalized.startsWith("CREATE UNIQUE INDEX ") || normalized.startsWith("CREATE VIEW ")) schemaAfterData.push(statement);
    else throw new Error(`Unsupported statement in D1 export: ${statement.slice(0, 80)}`);
  }

  if (tables.length === 0 || data.length === 0) throw new Error("D1 export did not contain both schema and data");
  return ["PRAGMA defer_foreign_keys=TRUE;", ...tables, ...data, ...schemaAfterData, ""].join("\n");
}

if (process.argv[1]?.endsWith("prepare-d1-export.ts")) {
  const input = process.argv[2];
  const output = process.argv[3];
  if (!input || !output) throw new Error("Usage: npx tsx scripts/prepare-d1-export.ts <input.sql> <output.sql>");
  writeFileSync(output, prepareD1Export(readFileSync(input, "utf8")));
  console.log(`Prepared importable D1 export: ${output}`);
}
