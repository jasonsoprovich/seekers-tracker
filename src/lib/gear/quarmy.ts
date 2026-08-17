// Parses a Zeal `<CharName>-Quarmy.txt` export (§4/§8: ported from
// pq-companion's zeal.ParseQuarmy, `.../pq-companion/backend/internal/zeal/reader.go`).
// The file has up to four tab-delimited sections: a character-stats header +
// data row, an inventory table (header row starts with "Location"), an AA
// table (header "AAIndex"), and a tradeskill table (header "SkillID", Zeal
// 1.4.3+). Only the inventory section matters for the gear list — no stat
// math, no AA/tradeskill tracking (§8 Phase 2 scope).
//
// Only worn-equipment locations are kept ("here's what they're wearing", not
// bags/bank). Zeal's three doubled slots (ears, wrists, rings) come out as
// numbered locations (Ear1/Ear2, Wrist1/Wrist2, Finger1/Finger2) in the
// modern export format, or as repeated bare locations (Ear, Wrist, Fingers)
// in the older one — see pq-companion reader.go's inventorySlotAliases
// comment. Either way, each physical slot needs a distinct key (see
// slots.ts), so repeated bare locations are numbered here by order of
// appearance.
import { GEAR_SLOTS, type GearSlotKey } from "./slots";

export interface QuarmyGearEntry {
  slot: GearSlotKey;
  itemId: number;
  itemName: string;
}

const KNOWN_SLOTS = new Set<string>(GEAR_SLOTS.map((s) => s.key));
const DOUBLED_BASES = new Set(["Ear", "Wrist", "Fingers"]);

function normalizeLocation(rawLocation: string, seen: Map<string, number>): GearSlotKey | null {
  const loc = rawLocation.trim();
  if (loc === "Finger1") return "Fingers1";
  if (loc === "Finger2") return "Fingers2";
  if (KNOWN_SLOTS.has(loc)) return loc as GearSlotKey;
  if (DOUBLED_BASES.has(loc)) {
    const n = (seen.get(loc) ?? 0) + 1;
    seen.set(loc, n);
    return n <= 2 ? (`${loc}${n}` as GearSlotKey) : null;
  }
  return null;
}

export function parseQuarmyGear(text: string): QuarmyGearEntry[] {
  const entries: QuarmyGearEntry[] = [];
  const seen = new Map<string, number>();
  let inInventory = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const parts = line.split("\t");
    const firstField = parts[0]!.trim().toLowerCase();

    if (firstField === "aaindex" || firstField === "skillid") {
      inInventory = false;
      continue;
    }
    if (firstField === "location") {
      inInventory = true;
      continue;
    }
    if (firstField === "checksum" || firstField === "character") continue;
    if (!inInventory || parts.length < 3) continue;

    const itemId = Number.parseInt(parts[2]!.trim(), 10);
    if (!Number.isInteger(itemId) || itemId <= 0) continue;

    const slot = normalizeLocation(parts[0]!, seen);
    if (!slot) continue;

    entries.push({ slot, itemId, itemName: parts[1]!.trim() });
  }

  return entries;
}
