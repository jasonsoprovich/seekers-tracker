import { inArray } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { items } from "@/db";
import { normalizeItemName } from "@/lib/items/normalize";

type Db = ReturnType<typeof drizzle>;

// D1 caps a statement at 100 bound parameters (see CLAUDE.md) — stay under it.
const CHUNK = 90;
export const MAX_RESOLVE_NAMES = 200;

// Name -> PQDI/Quarm item id (null when the name isn't a known item). The
// items table holds one row per normalized name already (see
// scripts/import-items.ts), so this is a plain lookup.
export async function resolveItemNames(db: Db, names: string[]): Promise<Record<string, number | null>> {
  const normByName = new Map<string, string>();
  for (const n of names) if (typeof n === "string" && n.trim()) normByName.set(n, normalizeItemName(n));
  const norms = [...new Set(normByName.values())];
  const idByNorm = new Map<string, number>();
  for (let i = 0; i < norms.length; i += CHUNK) {
    const rows = await db
      .select({ id: items.id, norm: items.normName })
      .from(items)
      .where(inArray(items.normName, norms.slice(i, i + CHUNK)));
    for (const r of rows) idByNorm.set(r.norm, r.id);
  }
  const out: Record<string, number | null> = {};
  for (const [name, norm] of normByName) out[name] = idByNorm.get(norm) ?? null;
  return out;
}
