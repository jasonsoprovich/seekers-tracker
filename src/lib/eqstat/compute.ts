import {
  acBreakdown,
  capAttribute,
  defenseSkillCap,
  maxHP,
  maxMana,
  resistance,
  type ACBreakdown,
  type Attributes,
  type Resists,
} from "./formulas";
import { getItemStats } from "./item-stats";

export interface GearStatTotals {
  ac: number;
  hp: number;
  mana: number;
  str: number;
  sta: number;
  agi: number;
  dex: number;
  wis: number;
  int: number;
  cha: number;
  mr: number;
  cr: number;
  fr: number;
  dr: number;
  pr: number;
}

const ZERO_TOTALS: GearStatTotals = {
  ac: 0,
  hp: 0,
  mana: 0,
  str: 0,
  sta: 0,
  agi: 0,
  dex: 0,
  wis: 0,
  int: 0,
  cha: 0,
  mr: 0,
  cr: 0,
  fr: 0,
  dr: 0,
  pr: 0,
};

// Sums every worn item's stat contribution. Items with no entry in the
// trimmed lookup (unrecognized id, or an item with no stats at all)
// contribute nothing rather than erroring — a gear list is allowed to
// contain items this dataset doesn't know about.
export function sumGearStats(itemIds: number[]): GearStatTotals {
  const totals = { ...ZERO_TOTALS };
  for (const id of itemIds) {
    const s = getItemStats(id);
    if (!s) continue;
    totals.ac += s.ac ?? 0;
    totals.hp += s.hp ?? 0;
    totals.mana += s.mana ?? 0;
    totals.str += s.str ?? 0;
    totals.sta += s.sta ?? 0;
    totals.agi += s.agi ?? 0;
    totals.dex += s.dex ?? 0;
    totals.wis += s.wis ?? 0;
    totals.int += s.int ?? 0;
    totals.cha += s.cha ?? 0;
    totals.mr += s.mr ?? 0;
    totals.cr += s.cr ?? 0;
    totals.fr += s.fr ?? 0;
    totals.dr += s.dr ?? 0;
    totals.pr += s.pr ?? 0;
  }
  return totals;
}

export interface DerivedStats {
  gear: GearStatTotals;
  attributes: Attributes; // base + gear, capped at the level's attribute cap
  hp: number;
  mana: number;
  resists: Resists;
  ac: ACBreakdown;
}

// Computes the full gear-only derived stat sheet: base attributes (from
// character_stats) + summed gear bonuses, capped, then fed through the
// ported formulas. No buffs, no AA, no spell effects — see formulas.ts's
// scope note.
export function computeDerivedStats(params: {
  class: number;
  level: number;
  race: number;
  base: Attributes;
  itemIds: number[];
}): DerivedStats {
  const { class: cls, level, race, base, itemIds } = params;
  const gear = sumGearStats(itemIds);

  const attributes: Attributes = {
    str: capAttribute(base.str + gear.str, level),
    sta: capAttribute(base.sta + gear.sta, level),
    agi: capAttribute(base.agi + gear.agi, level),
    dex: capAttribute(base.dex + gear.dex, level),
    wis: capAttribute(base.wis + gear.wis, level),
    int: capAttribute(base.int + gear.int, level),
    cha: capAttribute(base.cha + gear.cha, level),
  };

  const hp = maxHP(cls, level, attributes.sta, gear.hp);
  const mana = maxMana(cls, level, attributes.wis, attributes.int, gear.mana);
  const resists = resistance(cls, level, race, { mr: gear.mr, cr: gear.cr, fr: gear.fr, dr: gear.dr, pr: gear.pr });
  const defenseSkill = defenseSkillCap(cls, level);
  const ac = acBreakdown(cls, level, race, gear.ac, attributes.agi, defenseSkill);

  return { gear, attributes, hp, mana, resists, ac };
}
