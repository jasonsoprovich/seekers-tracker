// Port of pq-companion's zeal.ParseSpellbook (backend/internal/zeal/
// reader.go). Zeal's /outputfile spellbook writes <Name>-Spellbook.txt (or
// <Name>-Spellbook_pq.proj.txt) listing everything scribed in the book — one
// spell per line in one of several shapes:
//
//   "1234"                        id only
//   "3\t1234"                     slot\tspell_id
//   "1234\tSome Spell Name"       spell_id\tname
//   "26\t1359\t8\tEnchant Clay"   index\tspell_id\tlevel\tname (current format,
//                                 with an "Index\tSpellId\tLevel\tName" header)
//
// Keep the two in sync if Zeal's format changes.

import type { ClassSpell } from "./index";

export interface ParsedSpellbook {
  spellIds: Set<number>;
  // Lowercased; the fallback match key in case an exported id ever drifts
  // from the bundled quarm.db id.
  names: Set<string>;
  lineCount: number;
}

function parseLine(line: string): { id: number; name: string } | null {
  const parts = line.split("\t").map((p) => p.trim());
  const num = (s: string) => (/^-?\d+$/.test(s) ? Number(s) : NaN);

  if (parts.length === 1) {
    const n = num(parts[0]);
    return Number.isNaN(n) ? null : { id: n, name: "" };
  }

  // Prefer the 2nd field (slot/index-led formats), then the 1st (id\tname).
  let id = num(parts[1]);
  if (Number.isNaN(id)) id = num(parts[0]);
  if (Number.isNaN(id)) return null;

  const last = parts[parts.length - 1];
  const name = last !== "" && Number.isNaN(num(last)) ? last : "";
  return { id, name };
}

export function parseZealSpellbook(text: string): ParsedSpellbook {
  const out: ParsedSpellbook = { spellIds: new Set(), names: new Set(), lineCount: 0 };
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === "") continue;
    const parsed = parseLine(raw);
    // The header row ("Index\tSpellId\t...") and junk lines fall out here.
    if (!parsed || parsed.id <= 0) continue;
    out.lineCount++;
    out.spellIds.add(parsed.id);
    if (parsed.name) out.names.add(parsed.name.toLowerCase());
  }
  return out;
}

// Which of a class's tracked spells the spellbook contains — by id, or by
// name when the id doesn't match.
export function matchSpellbook(book: ParsedSpellbook, classSpells: readonly ClassSpell[]): ClassSpell[] {
  return classSpells.filter((s) => book.spellIds.has(s.spellId) || book.names.has(s.name.toLowerCase()));
}
