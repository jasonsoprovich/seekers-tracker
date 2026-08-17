import { sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { characterEpgp, characters } from "@/db";

import { findColumn, headerIndex, parseCsv } from "./csv";

// The guild's hand-maintained EPGP sheet (§10), reviewed directly — kept as
// a fallback default so this works out of the box, but overridable via
// SEEKERS_EPGP_SHEET_ID if the guild ever moves it.
const DEFAULT_SHEET_ID = "1pu43LSErcxSaaAkaaTrvMi8GfZYV-dRf1qaWyKiveAA";

function sheetCsvUrl(sheetName: string): string {
  const id = process.env.SEEKERS_EPGP_SHEET_ID || DEFAULT_SHEET_ID;
  return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
}

export type EpgpSyncResult = {
  matched: number;
  unmatched: string[];
};

// Header text varies slightly across sheet revisions (§10's "known
// fragility" note), so match by normalized header text, not column
// position, and fail loud if the required columns aren't found at all.
const NAME_HEADERS = ["character", "character name", "name", "toon"];
const EP_HEADERS = ["ep"];
const GP_HEADERS = ["gp"];
const PRIORITY_HEADERS = ["loot priority", "priority rating", "priority"];

// Read-only sync of the "Totals" tab into `character_epgp` (§9 task 20,
// Totals half). Matches sheet rows to `characters` by exact (trimmed,
// case-insensitive) name — the sheet has no player/account column, EPGP is
// tracked per character name only (§10). Never writes back to the sheet.
export async function syncEpgpTotals(db: ReturnType<typeof drizzle>): Promise<EpgpSyncResult> {
  const res = await fetch(sheetCsvUrl("Totals"));
  if (!res.ok) {
    throw new Error(`Failed to fetch EPGP sheet (Totals tab): HTTP ${res.status}`);
  }
  const csv = await res.text();
  const rows = parseCsv(csv);
  if (rows.length < 2) {
    throw new Error("EPGP sheet's Totals tab returned no data rows.");
  }

  const [headerRow, ...dataRows] = rows;
  const headers = headerIndex(headerRow);
  const nameCol = findColumn(headers, NAME_HEADERS);
  const epCol = findColumn(headers, EP_HEADERS);
  const gpCol = findColumn(headers, GP_HEADERS);
  const priorityCol = findColumn(headers, PRIORITY_HEADERS);

  if (nameCol === undefined || epCol === undefined || gpCol === undefined || priorityCol === undefined) {
    throw new Error(
      "EPGP sheet's Totals tab is missing an expected column (character name, EP, GP, or Loot Priority) — " +
        "the sheet's shape may have changed. Refusing to sync rather than import garbage.",
    );
  }

  const allCharacters = await db.select({ id: characters.id, name: characters.name }).from(characters);
  const byName = new Map(allCharacters.map((c) => [c.name.trim().toLowerCase(), c.id]));

  let matched = 0;
  const unmatched: string[] = [];

  for (const row of dataRows) {
    const name = (row[nameCol] ?? "").trim();
    if (!name) continue;

    const characterId = byName.get(name.toLowerCase());
    if (characterId === undefined) {
      unmatched.push(name);
      continue;
    }

    const ep = Number(row[epCol]);
    const gp = Number(row[gpCol]);
    const priorityRating = Number(row[priorityCol]);
    if (!Number.isFinite(ep) || !Number.isFinite(gp) || !Number.isFinite(priorityRating)) {
      unmatched.push(`${name} (non-numeric EP/GP/priority)`);
      continue;
    }

    await db
      .insert(characterEpgp)
      .values({ characterId, ep, gp, priorityRating, lastSyncedAt: new Date() })
      .onConflictDoUpdate({
        target: characterEpgp.characterId,
        set: { ep, gp, priorityRating, lastSyncedAt: sql`(unixepoch())` },
      });
    matched++;
  }

  return { matched, unmatched };
}
