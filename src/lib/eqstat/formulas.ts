// Ported from pq-companion's `backend/internal/eqstat/eqstat.go`, which
// itself reimplements Project Quarm's (EQMacEmu fork) server-side player
// stat formulas from zone/client_mods.cpp, zone/attack.cpp, zone/bonuses.cpp.
// See that file's header comment for the full sourcing note.
//
// Scope note (§8 Phase 3 / task 18): this port covers exactly what task 18
// asks for — HP, mana, AC, resists, computed from gear + base attributes.
// It deliberately does NOT port eqstat's Tanking (softcap/Combat Stability),
// DisplayedATK, or regen helpers — those need buff/AA/weapon-skill inputs
// this app has no way to collect (no buff or AA tracking), and weren't part
// of task 18's ask. All values here are a gear-only snapshot: no buffs, no
// AA bonuses, no spell effects.
//
// All arithmetic uses `idiv` (Math.trunc-based integer division) to match
// Go's int32 truncation — using plain float division would round
// differently and drift from the values pq-companion (and the live client)
// show.
import defenseSkillCapData from "@/data/defense-skill-cap.json";

function idiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

// EQ class indices, 0-indexed — matches this app's CHAR_CLASSES (src/lib/eq/enums.ts).
export const CLASS = {
  Warrior: 0,
  Cleric: 1,
  Paladin: 2,
  Ranger: 3,
  ShadowKnight: 4,
  Druid: 5,
  Monk: 6,
  Bard: 7,
  Rogue: 8,
  Shaman: 9,
  Necromancer: 10,
  Wizard: 11,
  Magician: 12,
  Enchanter: 13,
  Beastlord: 14,
} as const;

// EQ race ids (raw, matching characters.race / CHAR_RACES) — Iksar and Vah
// Shir use the high client ids.
export const RACE = {
  Human: 1,
  Barbarian: 2,
  Erudite: 3,
  WoodElf: 4,
  HighElf: 5,
  DarkElf: 6,
  HalfElf: 7,
  Dwarf: 8,
  Troll: 9,
  Ogre: 10,
  Halfling: 11,
  Gnome: 12,
  Iksar: 128,
  VahShir: 130,
} as const;

// HP and mana both clamp to this signed-16-bit ceiling server-side.
const VITAL_CAP = 32767;

export interface Attributes {
  str: number;
  sta: number;
  agi: number;
  dex: number;
  wis: number;
  int: number;
  cha: number;
}

export interface Resists {
  mr: number;
  cr: number;
  fr: number;
  dr: number;
  pr: number;
}

// ── HP ───────────────────────────────────────────────────────────────────

// classLevelFactor is EQMacEmu's per-class HP-per-level multiplier
// (GetClassLevelFactor). baseHP divides this by 10.
function classLevelFactor(cls: number, level: number): number {
  switch (cls) {
    case CLASS.Warrior:
      if (level < 20) return 220;
      if (level < 30) return 230;
      if (level < 40) return 250;
      if (level < 53) return 270;
      if (level < 57) return 280;
      if (level < 60) return 290;
      if (level < 70) return 300;
      return 311;
    case CLASS.Cleric:
    case CLASS.Druid:
    case CLASS.Shaman:
      return level < 70 ? 150 : 157;
    case CLASS.Paladin:
    case CLASS.ShadowKnight:
      if (level < 35) return 210;
      if (level < 45) return 220;
      if (level < 51) return 230;
      if (level < 56) return 240;
      if (level < 60) return 250;
      if (level < 68) return 260;
      return 270;
    case CLASS.Monk:
    case CLASS.Bard:
    case CLASS.Rogue:
    case CLASS.Beastlord:
      if (level < 51) return 180;
      if (level < 58) return 190;
      if (level < 70) return 200;
      return 210;
    case CLASS.Ranger:
      if (level < 58) return 200;
      if (level < 70) return 210;
      return 220;
    case CLASS.Magician:
    case CLASS.Wizard:
    case CLASS.Necromancer:
    case CLASS.Enchanter:
      return level < 70 ? 120 : 127;
    default:
      if (level < 35) return 210;
      if (level < 45) return 220;
      if (level < 51) return 230;
      if (level < 56) return 240;
      if (level < 60) return 250;
      return 260;
  }
}

// baseHP: level x (factor/10), scaled by STA. STA over 255 counts half.
export function baseHP(cls: number, level: number, sta: number): number {
  const lm = idiv(classLevelFactor(cls, level), 10);
  const levelHP = level * lm;
  const staFactor = sta > 255 ? idiv(sta - 255, 2) + 255 : sta;
  return idiv(levelHP * staFactor, 300) + levelHP;
}

// maxHP: base + item HP, clamped. buffHP/aaFlatHP/aaHPPct default to 0 —
// this app has no buff or AA tracking (see scope note above).
export function maxHP(
  cls: number,
  level: number,
  sta: number,
  itemHP: number,
  buffHP = 0,
  aaFlatHP = 0,
  aaHPPct = 0,
): number {
  let val = baseHP(cls, level, sta) + itemHP;
  if (aaHPPct > 0) val += idiv(val * aaHPPct, 100);
  val += aaFlatHP + 5;
  val += buffHP;
  if (val > VITAL_CAP) val = VITAL_CAP;
  if (val < 0) val = 0;
  return val;
}

// ── Mana ─────────────────────────────────────────────────────────────────

type CasterType = "int" | "wis" | "none";

export function casterType(cls: number): CasterType {
  switch (cls) {
    case CLASS.Necromancer:
    case CLASS.Wizard:
    case CLASS.Magician:
    case CLASS.Enchanter:
    case CLASS.ShadowKnight:
      return "int";
    case CLASS.Cleric:
    case CLASS.Druid:
    case CLASS.Shaman:
    case CLASS.Paladin:
    case CLASS.Ranger:
    case CLASS.Beastlord:
      return "wis";
    default:
      return "none";
  }
}

export function baseMana(cls: number, level: number, prime: number): number {
  if (casterType(cls) === "none") return 0;
  const levelFactor = 15 * level;
  let statFactor = prime > 200 ? idiv(prime - 200, 2) + 200 : prime;
  if (statFactor > 100) statFactor += idiv(3 * (statFactor - 100), 2);
  return idiv(statFactor * levelFactor, 200) + levelFactor;
}

// maxMana: flatMana is the summed item mana-pool contribution (no buffs/AA — see scope note).
export function maxMana(cls: number, level: number, wis: number, intel: number, flatMana: number): number {
  const ct = casterType(cls);
  if (ct === "none") return 0;
  if ((cls === CLASS.Ranger || cls === CLASS.Paladin || cls === CLASS.Beastlord) && level < 9) return 0;
  const prime = ct === "wis" ? wis : intel;
  let m = baseMana(cls, level, prime) + flatMana;
  if (m < 0) m = 0;
  if (m > VITAL_CAP) m = VITAL_CAP;
  return m;
}

// ── Resists ──────────────────────────────────────────────────────────────

function baseResists(race: number): Resists {
  switch (race) {
    case RACE.Barbarian:
      return { mr: 25, cr: 35, fr: 25, dr: 15, pr: 15 };
    case RACE.Erudite:
      return { mr: 30, cr: 25, fr: 25, dr: 10, pr: 15 };
    case RACE.Dwarf:
      return { mr: 30, cr: 25, fr: 25, dr: 15, pr: 20 };
    case RACE.Troll:
      return { mr: 25, cr: 25, fr: 5, dr: 15, pr: 15 };
    case RACE.Halfling:
      return { mr: 25, cr: 25, fr: 25, dr: 20, pr: 20 };
    case RACE.Iksar:
      return { mr: 25, cr: 15, fr: 30, dr: 15, pr: 15 };
    case RACE.Human:
    case RACE.WoodElf:
    case RACE.HighElf:
    case RACE.DarkElf:
    case RACE.HalfElf:
    case RACE.Ogre:
    case RACE.Gnome:
    case RACE.VahShir:
      return { mr: 25, cr: 25, fr: 25, dr: 15, pr: 15 };
    default:
      return { mr: 20, cr: 25, fr: 20, dr: 15, pr: 15 };
  }
}

function classLevelResistBonus(cls: number, level: number): Resists {
  const r: Resists = { mr: 0, cr: 0, fr: 0, dr: 0, pr: 0 };
  const overOld = level > 49 ? level - 49 : 0;
  const over50 = level > 50 ? level - 50 : 0;
  switch (cls) {
    case CLASS.Warrior:
      r.mr += idiv(level, 2);
      break;
    case CLASS.Ranger:
      r.fr += 4 + overOld;
      r.cr += 4 + overOld;
      break;
    case CLASS.Monk:
      r.fr += 8 + overOld;
      r.dr += over50;
      r.pr += over50;
      break;
    case CLASS.Paladin:
      r.dr += 8 + overOld;
      break;
    case CLASS.ShadowKnight:
      r.dr += 4 + overOld;
      r.pr += 4 + overOld;
      break;
    case CLASS.Beastlord:
      r.dr += 4 + overOld;
      r.cr += 4 + overOld;
      break;
    case CLASS.Rogue:
      r.pr += 8 + overOld;
      break;
  }
  return r;
}

const RESIST_CAP = 500;

function clampResist(v: number, capMod: number): number {
  if (v < 1) v = 1;
  const max = RESIST_CAP + capMod;
  if (v > max) v = max;
  return v;
}

// resistance: racial base + class/level bonus + summed item resists (add),
// floored at 1 and capped at RESIST_CAP (+ capMod, always 0 here — no AA).
export function resistance(cls: number, level: number, race: number, add: Resists, capMod: Resists = ZERO_RESISTS): Resists {
  const base = baseResists(race);
  const cl = classLevelResistBonus(cls, level);
  return {
    mr: clampResist(base.mr + cl.mr + add.mr, capMod.mr),
    cr: clampResist(base.cr + cl.cr + add.cr, capMod.cr),
    fr: clampResist(base.fr + cl.fr + add.fr, capMod.fr),
    dr: clampResist(base.dr + cl.dr + add.dr, capMod.dr),
    pr: clampResist(base.pr + cl.pr + add.pr, capMod.pr),
  };
}

const ZERO_RESISTS: Resists = { mr: 0, cr: 0, fr: 0, dr: 0, pr: 0 };

// ── Attribute cap ────────────────────────────────────────────────────────

export function maxStat(level: number, capMod = 0): number {
  let base = 255;
  if (level > 60) base += (level - 60) * 5;
  return base + capMod;
}

export function capAttribute(v: number, level: number, capMod = 0): number {
  const m = maxStat(level, capMod);
  return v > m ? m : v;
}

// ── AC ───────────────────────────────────────────────────────────────────

// isACCaster: the four INT casters get the pure-caster AC path (raw item AC,
// no x4/3). ShadowKnight is NOT included even though it casts INT spells.
function isACCaster(cls: number): boolean {
  return cls === CLASS.Wizard || cls === CLASS.Magician || cls === CLASS.Necromancer || cls === CLASS.Enchanter;
}

// avoidance: the roll-to-be-hit half of displayed AC.
function avoidance(defenseSkill: number, agi: number, level: number): number {
  const defenseAvoidance = defenseSkill > 0 ? idiv(defenseSkill * 400, 225) : 0;

  let agiAvoidance: number;
  if (agi < 40) {
    agiAvoidance = idiv(25 * (agi - 40), 40);
  } else if (agi < 60) {
    agiAvoidance = 0;
  } else if (agi <= 74) {
    agiAvoidance = idiv(2 * (28 - idiv(200 - agi, 5)), 3);
  } else {
    let bonusAdj = 80;
    if (level < 7) bonusAdj = 35;
    else if (level < 20) bonusAdj = 55;
    else if (level < 40) bonusAdj = 70;
    agiAvoidance = agi < 200 ? idiv(2 * (bonusAdj - idiv(200 - agi, 5)), 3) : idiv(2 * bonusAdj, 3);
  }

  const computed = defenseAvoidance + agiAvoidance;
  return computed < 1 ? 1 : computed;
}

// agiTierBonus: the small AGI-tiered AC bonus shared by Rogue/Beastlord.
function agiTierBonus(agi: number): number {
  if (agi >= 100) return 12;
  if (agi >= 90) return 9;
  if (agi >= 85) return 6;
  if (agi >= 80) return 3;
  return 0;
}

// classRaceACBonus: inlined class/race innate AC — Iksar skin AC, plus the
// Monk/Rogue/Beastlord innate bonuses. (The Go source's `weight` parameter
// is dead code in the Monk branch — "we model the common light-monk case" —
// so it's omitted here entirely rather than ported unused.)
function classRaceACBonus(cls: number, level: number, race: number, agi: number): number {
  let bonus = 0;

  if (race === RACE.Iksar) {
    if (level < 10) bonus += 10;
    else if (level > 35) bonus += 35;
    else bonus += level;
  }

  switch (cls) {
    case CLASS.Monk: {
      const acBonus = level + 5;
      bonus += idiv(acBonus * 4, 3);
      break;
    }
    case CLASS.Rogue:
      if (level >= 30 && agi > 75) bonus += Math.min(agiTierBonus(agi), 12);
      break;
    case CLASS.Beastlord:
      if (level > 10) bonus += Math.min(agiTierBonus(agi), 16);
      break;
  }
  return bonus;
}

// mitigation: the damage-per-landed-hit half of displayed AC. itemAC is the
// summed worn-item AC; spellAC (buff/song AC) is always 0 here — see scope
// note. Uses the "displayed" (ignoreCap) path, matching the client's
// inventory-window number, not the in-combat softcap.
function mitigation(cls: number, level: number, race: number, itemAC: number, spellAC: number, agi: number, defenseSkill: number): number {
  let acSum = itemAC;
  if (!isACCaster(cls)) acSum = idiv(4 * acSum, 3);

  acSum += classRaceACBonus(cls, level, race, agi);

  if (defenseSkill > 0) {
    acSum += isACCaster(cls) ? idiv(defenseSkill, 2) : idiv(defenseSkill, 3);
  }

  const spellDivisor = isACCaster(cls) ? 3 : 4;
  acSum += idiv(spellAC, spellDivisor);

  if (agi > 70) acSum += idiv(agi, 20);

  return acSum < 0 ? 0 : acSum;
}

export interface ACBreakdown {
  avoidance: number;
  mitigation: number;
  displayedAC: number;
}

// acBreakdown: avoidance/mitigation split and displayed AC —
// DisplayedAC = (avoidance + mitigation) x 1000 / 847.
export function acBreakdown(
  cls: number,
  level: number,
  race: number,
  itemAC: number,
  agi: number,
  defenseSkill: number,
): ACBreakdown {
  const av = avoidance(defenseSkill, agi, level);
  const mit = mitigation(cls, level, race, itemAC, 0, agi, defenseSkill);
  return { avoidance: av, mitigation: mit, displayedAC: idiv((av + mit) * 1000, 847) };
}

// ── Defense skill cap ────────────────────────────────────────────────────
// Same assumption pq-companion makes: this app tracks no live skill values,
// so Defense is assumed at the class/level cap (a max-effort main is
// virtually always there in practice). Sourced from quarm.db's
// skill_caps table (skill_id 15), keyed "<1-indexed class>-<level>".
const defenseSkillCaps = defenseSkillCapData as Record<string, number>;

export function defenseSkillCap(cls: number, level: number): number {
  if (level <= 0) return 0;
  return defenseSkillCaps[`${cls + 1}-${level}`] ?? 0;
}
