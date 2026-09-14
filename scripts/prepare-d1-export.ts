// Reorder a Cloudflare D1 SQL export for import into a fresh D1 database.
// D1 exports table rows immediately after each CREATE TABLE, which fails when
// those rows reference a table that appears later in the dump. Remote imports
// also enforce cyclic foreign keys before the dump has restored both sides.
import { readFileSync, writeFileSync } from "node:fs";

const DEFERRED_COLUMNS: Record<string, string[]> = {
  characters: ["main_character_id"],
  players: ["main_character_id", "removal_decay_event_id"],
  loot_events: ["winning_bid_id"],
};

function identifier(value: string): string {
  return value.trim().replace(/^["`[]|["`\]]$/g, "");
}

function splitList(value: string): string[] {
  const fields: string[] = [];
  let start = 0;
  let quote: "'" | '"' | "`" | null = null;
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quote) {
      if (char === quote) {
        if (value[i + 1] === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      fields.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  fields.push(value.slice(start).trim());
  return fields;
}

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
  const tableOrder: string[] = [];
  const dependencies = new Map<string, Set<string>>();
  const inserts = new Map<string, string[]>();
  const deletes: string[] = [];
  const deferredUpdates: string[] = [];
  const schemaAfterData: string[] = [];

  for (const statement of splitStatements(sql)) {
    const normalized = statement.trimStart().toUpperCase();
    if (normalized.startsWith("PRAGMA ")) continue;
    if (normalized.startsWith("CREATE TABLE ")) {
      const tableMatch = statement.match(/^CREATE TABLE(?: IF NOT EXISTS)?\s+(["`[]?[^\s("`\]]+["`\]]?)/i);
      if (!tableMatch) throw new Error(`Cannot parse table name: ${statement.slice(0, 80)}`);
      const tableName = identifier(tableMatch[1]);
      const refs = new Set<string>();
      const definitions = splitList(statement.slice(statement.indexOf("(") + 1, statement.lastIndexOf(")")));
      for (const definition of definitions) {
        const reference = definition.match(/\bREFERENCES\s+(["`[]?[^\s("`\]]+["`\]]?)/i);
        if (!reference) continue;
        const foreignKey = definition.match(/FOREIGN KEY\s*\(\s*(["`[]?[^\s)"`\]]+["`\]]?)/i);
        const inlineColumn = definition.match(/^\s*(["`[]?[^\s"`\]]+["`\]]?)/);
        const columnName = identifier((foreignKey ?? inlineColumn)?.[1] ?? "");
        if (!DEFERRED_COLUMNS[tableName]?.includes(columnName)) refs.add(identifier(reference[1]));
      }
      tables.push(statement);
      tableOrder.push(tableName);
      dependencies.set(tableName, refs);
    }
    else if (normalized.startsWith("INSERT INTO ")) {
      const insertMatch = statement.match(/^INSERT INTO\s+(["`[]?[^\s("`\]]+["`\]]?)\s*\((.*?)\)\s*VALUES\s*\((.*)\);$/is);
      if (!insertMatch) throw new Error(`Cannot parse insert: ${statement.slice(0, 80)}`);
      const tableName = identifier(insertMatch[1]);
      const columns = splitList(insertMatch[2]);
      const values = splitList(insertMatch[3]);
      if (columns.length !== values.length) throw new Error(`Column/value mismatch for ${tableName}`);

      const restored: string[] = [];
      for (const deferredColumn of DEFERRED_COLUMNS[tableName] ?? []) {
        const index = columns.findIndex((column) => identifier(column) === deferredColumn);
        if (index >= 0 && values[index].toUpperCase() !== "NULL") {
          restored.push(`"${deferredColumn}" = ${values[index]}`);
          values[index] = "NULL";
        }
      }
      if (restored.length) {
        const idIndex = columns.findIndex((column) => identifier(column) === "id");
        if (idIndex < 0) throw new Error(`Cannot restore deferred columns for ${tableName} without id`);
        deferredUpdates.push(`UPDATE "${tableName}" SET ${restored.join(", ")} WHERE "id" = ${values[idIndex]};`);
      }

      const prepared = `INSERT INTO ${insertMatch[1]} (${columns.join(",")}) VALUES(${values.join(",")});`;
      inserts.set(tableName, [...(inserts.get(tableName) ?? []), prepared]);
    }
    else if (normalized.startsWith("DELETE FROM ")) deletes.push(statement);
    else if (normalized.startsWith("CREATE INDEX ") || normalized.startsWith("CREATE UNIQUE INDEX ") || normalized.startsWith("CREATE VIEW ")) schemaAfterData.push(statement);
    else throw new Error(`Unsupported statement in D1 export: ${statement.slice(0, 80)}`);
  }

  if (tables.length === 0 || inserts.size === 0) throw new Error("D1 export did not contain both schema and data");

  const pending = new Set(tableOrder);
  const orderedTables: string[] = [];
  while (pending.size) {
    const ready = tableOrder.find((tableName) =>
      pending.has(tableName) && [...(dependencies.get(tableName) ?? [])].every((dependency) => !pending.has(dependency))
    );
    if (!ready) throw new Error(`Cyclic foreign keys remain among: ${[...pending].join(", ")}`);
    pending.delete(ready);
    orderedTables.push(ready);
  }

  const orderedData = orderedTables.flatMap((tableName) => inserts.get(tableName) ?? []);
  return [
    "PRAGMA defer_foreign_keys=TRUE;",
    ...tables,
    ...deletes,
    ...orderedData,
    ...deferredUpdates,
    ...schemaAfterData,
    "",
  ].join("\n");
}

if (process.argv[1]?.endsWith("prepare-d1-export.ts")) {
  const input = process.argv[2];
  const output = process.argv[3];
  if (!input || !output) throw new Error("Usage: npx tsx scripts/prepare-d1-export.ts <input.sql> <output.sql>");
  writeFileSync(output, prepareD1Export(readFileSync(input, "utf8")));
  console.log(`Prepared importable D1 export: ${output}`);
}
