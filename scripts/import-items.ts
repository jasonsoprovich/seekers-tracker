// Seeds the `items` table (name -> PQDI item id) from the officer app's
// embedded Quarm item list, so the website can link/tooltip an item NAME.
//
//   npm run import:items            # writes data/items-seed.sql and applies it to LOCAL D1
//   npm run import:items -- --no-apply
//
// For production, apply the emitted file by hand (auto mode cannot):
//   npx wrangler d1 execute seekers-of-souls --remote --file data/items-seed.sql
//
// One row per normalized name: when several items share a name, the one
// dropped by the highest-level NPC wins (so Terris Thule's "Carved Bone Ring"
// beats Crusader Kezzal's), then the lowest id — the same tie-break the
// officer app uses (internal/items/items.go). Column 3 of the TSV is that drop
// level, 0 when nothing drops the item.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import { normalizeItemName } from "../src/lib/items/normalize";

const SRC = resolve(__dirname, "../../seekers-epgp-parser/internal/items/items.tsv.gz");
const OUT = resolve(__dirname, "../data/items-seed.sql");
const ROWS_PER_INSERT = 100;

type Row = { id: number; name: string; norm: string; level: number };

const best = new Map<string, Row>();
for (const line of new TextDecoder("utf-8").decode(gunzipSync(readFileSync(SRC))).split("\n")) {
  if (!line.trim()) continue;
  const [idStr, name, levelStr] = line.split("\t");
  const id = Number(idStr);
  if (!Number.isInteger(id) || !name) continue;
  const norm = normalizeItemName(name);
  const row: Row = { id, name, norm, level: Number(levelStr) || 0 };
  const cur = best.get(norm);
  if (!cur || row.level > cur.level || (row.level === cur.level && row.id < cur.id)) best.set(norm, row);
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const rows = [...best.values()].sort((a, b) => a.id - b.id);
const out: string[] = ["DELETE FROM items;"];
for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
  const values = rows.slice(i, i + ROWS_PER_INSERT).map((r) => `(${r.id},${q(r.name)},${q(r.norm)},${r.level > 0 ? 1 : 0})`);
  out.push(`INSERT INTO items (id,name,norm_name,droppable) VALUES ${values.join(",")};`);
}
writeFileSync(OUT, out.join("\n") + "\n");
console.log(`Wrote ${rows.length} items to ${OUT}`);

if (!process.argv.includes("--no-apply")) {
  execFileSync("npx", ["wrangler", "d1", "execute", "seekers-of-souls", "--local", `--file=${OUT}`], { stdio: "inherit" });
}
