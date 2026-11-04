// Verifies the SQL sandbox's table-reference scanner (src/lib/sql-sandbox.ts):
// every way of naming a non-v_ table must be caught, and ordinary queries over
// the v_ views must still pass. The paren cases were real bypasses (2026-11-03):
// `FROM (accounts a)` skipped the parenthesized list, and an alias after a
// subquery stopped the scan before the next comma.
// Pure (no DB). Usage: npx tsx scripts/verify-sql-sandbox.ts
import { findDisallowedTableRef } from "../src/lib/sql-sandbox";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
}

const blocked: string[] = [
  "SELECT * FROM accounts",
  "SELECT * FROM accounts a",
  "SELECT * FROM v_characters c, accounts a",
  "SELECT * FROM v_characters c JOIN sessions s ON 1",
  "SELECT * FROM main.apikeys",
  'SELECT * FROM "accounts"',
  "SELECT * FROM (accounts)",
  "SELECT * FROM (accounts AS z)",
  "SELECT * FROM ((sessions s))",
  "SELECT * FROM v_characters, (sessions s)",
  "SELECT * FROM (v_characters c, apikeys k)",
  "SELECT * FROM (SELECT 1) t, accounts a",
  "SELECT * FROM (SELECT 1) AS t, accounts a",
  "SELECT * FROM (SELECT * FROM v_characters) t JOIN accounts a ON 1",
  "SELECT * FROM v_characters WHERE id IN (SELECT 1 FROM (sessions s))",
  "WITH x AS (SELECT * FROM (accounts a)) SELECT * FROM x",
];
for (const q of blocked) {
  const ref = findDisallowedTableRef(q);
  check(`blocks: ${q}`, ref !== null, "returned null");
}

const allowed: string[] = [
  "SELECT 1",
  "SELECT * FROM v_characters",
  "SELECT * FROM v_characters c JOIN v_ep_ledger e ON e.character_id = c.id",
  "SELECT * FROM v_characters c, v_gp_ledger g WHERE g.character_id = c.id",
  "SELECT * FROM (SELECT * FROM v_characters) t",
  "SELECT * FROM (SELECT 1) t, v_characters c",
  "SELECT * FROM (v_characters c JOIN v_ep_ledger e ON e.character_id = c.id)",
  "SELECT * FROM (VALUES (1), (2)) v",
  "WITH top AS (SELECT * FROM v_characters) SELECT * FROM top",
  "SELECT name FROM v_characters WHERE name = 'accounts' ORDER BY name LIMIT 5",
];
for (const q of allowed) {
  const ref = findDisallowedTableRef(q);
  check(`allows: ${q}`, ref === null, `flagged ${ref}`);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
