// Ported from pq-companion's backend/internal/popflag/popflags_cmd.go (+ the
// block-extraction half of scan.go). Parses the player-facing '#popflags
// [overview|1|2|3|4|5|time]' command (EQMacEmu PR #382, zone/gm_commands/
// popflags.cpp), reworded by PR #487 (2026-10-22): per-boss "Pending memory: X"
// lines became "X flag: Complete|Pending memory|Missing" (BOSS_LINES), and the
// Fuirstel stages were reworded. Pre-#487 strings are still accepted (marked
// legacy) so older pasted logs keep parsing. Every literal string below is copied verbatim from the
// server source, so an upstream wording change fails loudly (the line simply
// stops matching) instead of silently mis-parsing.
//
// Unlike a Seer reading (one burst covering every qglobal), a '#popflags'
// report only covers the section the player ran. pq-companion merges each
// report onto a stored snapshot; this site stores no snapshot — instead the
// import action only ever ADDS completions derived from what a report says,
// never retracts one, so partial reports are safe to apply one at a time (or
// all together in one paste).

export type PopFlagsSection = "overview" | "tier1" | "tier2" | "tier3" | "tier4" | "time";

const HEADERS: Record<string, PopFlagsSection> = {
  "=== Planes of Power Progression ===": "overview",
  "=== Tier 1 Progression ===": "tier1",
  "=== Tier 2 Progression ===": "tier2",
  "=== Tier 3 Progression ===": "tier3",
  "=== Tier 4 Progression ===": "tier4",
  "=== Plane of Time ===": "time",
};

export interface PopFlagsReport {
  section?: PopFlagsSection;
  exact: Record<string, string>; // qglobal -> value ("" = confirmed absent)
  atLeast: Record<string, number>; // qglobal -> confirmed numeric floor
  pending: Record<string, boolean>; // cl_* checklist names the report named
}

function newReport(): PopFlagsReport {
  return { exact: {}, atLeast: {}, pending: {} };
}

function setAtLeast(r: PopFlagsReport, qglobal: string, floor: number) {
  if (!(qglobal in r.atLeast) || floor > r.atLeast[qglobal]) r.atLeast[qglobal] = floor;
}

// Since PR #487 only "Thelin's hedge maze" and "Karana" are still printed as
// "Pending memory: X"; the rest are legacy (now BOSS_LINES).
const PENDING_DESC: Record<string, string> = {
  Grummus: "cl_grummus",
  "Thelin's hedge maze": "cl_maze",
  "Manaetic Behemoth": "cl_behemoth",
  "Aerin`Dar": "cl_aerindar",
  "Terris Thule": "cl_terris",
  Bertoxxulous: "cl_bertox",
  "Keeper of Sorrows": "cl_keeper",
  Saryrn: "cl_saryrn",
  "Vallon Zek": "cl_vallon",
  "Tallon Zek": "cl_tallon",
  "Rallos Zek": "cl_rallos",
  Karana: "cl_karana",
  "Solusek Ro": "cl_solusek",
};

// Stage text: index N-1 is what the server prints when the qglobal's exact
// current value is N.
const MAVUIN = [
  "The evidence needed to save Mavuin has been requested",
  "The Tribunal has agreed to hear Mavuin's case",
  "Mavuin's case is complete",
];
const FUIRSTEL = [
  "Obtain the Ward for Milyk",
  "Grummus defeated; return to Elder Fuirstel",
  "Elder Fuirstel aided; defeat Bertoxxulous",
  "Bertoxxulous defeated; return to Elder Fuirstel",
  "Fuirstel progression complete",
];
// Pre-PR #487 wording for the same fuirstel values.
const FUIRSTEL_LEGACY = [
  "Obtain the Ward for Milyk",
  "The Ward was recovered",
  "Grummus was defeated",
  "Crypt of Decay access was granted",
  "Fuirstel progression complete",
];
const THELIN = [
  "Help Thelin escape the hedge maze",
  "Defeat Terris Thule",
  "Terris Thule was defeated",
  "Thelin was released from Terris Thule",
  "Nightmare progression complete",
];
const AERINDAR = ["Aerin`Dar defeated; the meaning of Justice remains", "Halls of Honor access unlocked"];
const TYLIS = ["Rescue Tylis from the Plane of Torment", "Tylis progression complete"];
const ZEKS = [
  "Initial Zek progression recorded",
  "Meet Giwin in Drunder",
  "Vallon Zek's information obtained",
  "Tallon Zek's information obtained",
  "Both Zek information sets obtained",
  "Defeat Rallos Zek",
  "Zek progression complete",
];
const KARANA_T2 = [
  "Prove yourself to Askr",
  "Complete Mavuin's case, then use the Storms shrine to enter Bastion of Thunder",
  "Bastion of Thunder progression recorded",
  "Karana's information obtained",
];
const KARANA_T3 = [
  "Return to Askr",
  "Complete Mavuin's case, then use the Storms shrine to enter Bastion of Thunder",
  "Karana progression continues",
  "Karana's information obtained",
];

const STAGE_LABELS: { label: string; qglobal: string; stages: string[]; legacy?: string[] }[] = [
  { label: "Mavuin's case", qglobal: "mavuin", stages: MAVUIN },
  { label: "Fuirstel progression", qglobal: "fuirstel", stages: FUIRSTEL, legacy: FUIRSTEL_LEGACY },
  { label: "Thelin progression", qglobal: "thelin", stages: THELIN },
  { label: "Aerin`Dar progression", qglobal: "aerindar", stages: AERINDAR },
  { label: "Tylis progression", qglobal: "tylis", stages: TYLIS },
  { label: "Giwin and Zek progression", qglobal: "zeks", stages: ZEKS },
];

const KARANA_LABELS: { label: string; stages: string[] }[] = [
  { label: "Askr and Karana progression", stages: KARANA_T2 },
  { label: "Agnarr and Karana progression", stages: KARANA_T3 },
];

type Effect = (r: PopFlagsReport) => void;
const exact = (q: string, v: string): Effect => (r) => {
  r.exact[q] = v;
};
const atLeast = (q: string, n: number): Effect => (r) => setAtLeast(r, q, n);
const noEffect: Effect = () => {};

const LITERAL_LINES: Record<string, Effect> = {
  "Seventh Hammer access: Unlocked": exact("seventh", "1"),
  "Seventh Hammer access: Locked": exact("seventh", ""),

  "Crypt of Decay access: Unlocked": exact("grummus", "1"),
  "Crypt of Decay access: Locked": exact("grummus", ""),

  "Factory door access: Unlocked": exact("poi_door", "1"),
  "Factory door access: Locked": exact("poi_door", ""),

  // Legacy (removed by PR #487).
  "Giwin and Manaetic Behemoth progression: Progress recorded": atLeast("zeks", 1),
  "Giwin and Manaetic Behemoth progression: Not started": exact("zeks", ""),

  "Lower Crypt access: Unlocked": exact("bertox_key", "1"),
  "Lower Crypt access: Locked": exact("bertox_key", ""),

  // Legacy cipher-half states (removed by PR #487). The shared "...: Complete"
  // state is handled by BOSS_LINES for both formats.
  "Saryrn cipher half: Combined into Cipher": atLeast("cipher", 1),
  "Saryrn cipher half: Incomplete": exact("saryrn", ""),
  "Mithaniel Marr cipher half: Combined into Cipher": atLeast("cipher", 1),
  "Mithaniel Marr cipher half: Incomplete": exact("mmarr", ""),

  // Miak's Tower preflag (pofire>=1||time). "Plane of Fire progression" in the
  // same section already reports pofire, so these add nothing.
  "Miak the Searedsoul preflag: Complete": noEffect,
  "Miak the Searedsoul preflag: Missing": noEffect,

  "Cipher information: Received": atLeast("cipher", 1),
  "Cipher information: Missing": noEffect,

  "Zebuxoruk lore: Received": atLeast("zebuxoruk", 1),
  "Zebuxoruk lore: Missing": noEffect,

  "Combined Zek information: Received": atLeast("zeks", 5),
  "Combined Zek information: Missing": noEffect,

  "Final elemental information: Received": atLeast("zebuxoruk", 2),
  "Final elemental information: Missing": noEffect,

  "Plane of Fire progression: Unlocked": atLeast("pofire", 2),
  "Plane of Fire progression: In progress": atLeast("pofire", 1),
  "Plane of Fire progression: Not started": exact("pofire", ""),

  "Plane of Earth B access: Unlocked": exact("earthb_key", "1"),
  "Plane of Earth B access: Locked": exact("earthb_key", ""),

  "Plane of Time access: Unlocked": exact("time", "1"),
  "Plane of Time access: Locked": exact("time", ""),

  "Air, Earth, and Water access: Unlocked": atLeast("zebuxoruk", 2),
  "Air, Earth, and Water access: Locked": noEffect,

  "Plane of Fire access: Unlocked": atLeast("pofire", 2),
  "Plane of Fire access: Locked": noEffect,

  "Halls of Honor trials: None completed": exact("hohtrials", "000"),
  "Tower wing flags: None completed": exact("sol_room", "00000"),

  // Overview per-tier status. "In progress" carries no qglobal state but must
  // be recognized so the block isn't split.
  "Tier 1: In progress": noEffect,
  "Tier 2: In progress": noEffect,
  "Tier 3: In progress": noEffect,
  "Tier 4: In progress": noEffect,

  "Tier 1: Complete": (r) => {
    setAtLeast(r, "mavuin", 3);
    setAtLeast(r, "fuirstel", 5);
    setAtLeast(r, "thelin", 4);
    setAtLeast(r, "poi_door", 1);
    setAtLeast(r, "zeks", 2);
  },
  "Tier 1: Not started": (r) => {
    for (const q of ["mavuin", "seventh", "fuirstel", "grummus", "thelin", "poi_door"]) r.exact[q] = "";
  },
  "Tier 2: Complete": (r) => {
    // karana>=2||zebuxoruk and saryrn||cipher are OR-conditions server-side —
    // deliberately not asserted here.
    setAtLeast(r, "aerindar", 2);
    r.exact["bertox_key"] = "1";
    setAtLeast(r, "tylis", 2);
  },
  "Tier 2: Not started": (r) => {
    for (const q of ["aerindar", "karana", "bertox_key", "tylis", "saryrn"]) r.exact[q] = "";
  },
  "Tier 3: Complete": (r) => {
    r.exact["hohtrials"] = "111";
    r.exact["sol_room"] = "11111";
    setAtLeast(r, "cipher", 1);
    setAtLeast(r, "zebuxoruk", 2);
    setAtLeast(r, "zeks", 7);
    setAtLeast(r, "pofire", 2);
  },
  "Tier 3: Not started": (r) => {
    for (const q of ["hohtrials", "mmarr", "mmarr_book", "cipher", "zebuxoruk", "zeks", "sol_room", "pofire"]) {
      r.exact[q] = "";
    }
  },
  "Tier 4: Complete": exact("time", "1"),
  "Tier 4: Not started": (r) => {
    r.exact["earthb_key"] = "";
    r.exact["time"] = "";
  },
  "Tier 5 - Plane of Time: Complete": exact("time", "1"),
  "Tier 5 - Plane of Time: Not started": exact("time", ""),
};

// PopFlagsPrintBoss call sites (PR #487): "<label>: Complete|Pending
// memory|Missing". Complete = the flag (or what it was combined into, or Time
// access) is held, and the server hides any stale memory; Missing = neither
// the flag nor its memory. Both clear the cl_* flag. When the boss's own stage
// line isn't printed in the same section, Complete also records `floor` on
// qglobal (Behemoth and Bertoxxulous — #487 dropped Tier 1's Giwin line, so
// the Behemoth flag is now Tier 1's only zeks signal). `absent` marks lines
// that are the sole report of their qglobal, so Missing confirms it absent
// (cipher halves and the book; Complete is a floor there since the half may
// since have been combined into cipher/zebuxoruk).
const BOSS_LINES: { label: string; pending: string; qglobal?: string; floor?: number; absent?: boolean }[] = [
  { label: "Grummus flag", pending: "cl_grummus" },
  { label: "Terris Thule flag", pending: "cl_terris" },
  { label: "Manaetic Behemoth flag", pending: "cl_behemoth", qglobal: "zeks", floor: 2 },
  { label: "Aerin`Dar flag", pending: "cl_aerindar" },
  { label: "Bertoxxulous flag", pending: "cl_bertox", qglobal: "fuirstel", floor: 4 },
  { label: "Keeper of Sorrows flag", pending: "cl_keeper" },
  { label: "Saryrn cipher half", pending: "cl_saryrn", qglobal: "saryrn", floor: 1, absent: true },
  { label: "Mithaniel Marr cipher half", pending: "cl_mmarr", qglobal: "mmarr", floor: 1, absent: true },
  { label: "Mithaniel Marr book", pending: "cl_mmarr_book", qglobal: "mmarr_book", floor: 1, absent: true },
  { label: "Agnarr / Karana flag", pending: "cl_karana" },
  { label: "Vallon Zek flag", pending: "cl_vallon" },
  { label: "Tallon Zek flag", pending: "cl_tallon" },
  { label: "Rallos Zek flag", pending: "cl_rallos" },
  { label: "Solusek Ro flag", pending: "cl_solusek" },
];

function matchBossLine(r: PopFlagsReport, line: string): boolean {
  for (const b of BOSS_LINES) {
    const prefix = `${b.label}: `;
    if (!line.startsWith(prefix)) continue;
    const rest = line.slice(prefix.length);
    if (rest === "Complete") {
      r.exact[b.pending] = "";
      if (b.qglobal && b.floor) setAtLeast(r, b.qglobal, b.floor);
    } else if (rest === "Pending memory") {
      r.pending[b.pending] = true;
    } else if (rest === "Missing") {
      r.exact[b.pending] = "";
      if (b.qglobal && b.absent) r.exact[b.qglobal] = "";
    } else {
      return false;
    }
    return true;
  }
  return false;
}

const BIT_LINES: { label: string; qglobal: "hohtrials" | "sol_room"; pos: number }[] = [
  { label: "Rydda`Dar trial", qglobal: "hohtrials", pos: 1 },
  { label: "Village trial", qglobal: "hohtrials", pos: 2 },
  { label: "Nomad trial", qglobal: "hohtrials", pos: 3 },
  { label: "Xuzl", qglobal: "sol_room", pos: 1 },
  { label: "Arlyxir", qglobal: "sol_room", pos: 2 },
  { label: "Dresolik", qglobal: "sol_room", pos: 3 },
  { label: "Rizlona", qglobal: "sol_room", pos: 4 },
  { label: "Jiva", qglobal: "sol_room", pos: 5 },
];

const BITMASK_WIDTH = 5;

// A bit is only known once its own line (or a "None completed" line) appears.
class BitState {
  known: boolean[] = Array(BITMASK_WIDTH).fill(false);
  set: boolean[] = Array(BITMASK_WIDTH).fill(false);
  apply(pos: number, done: boolean) {
    this.known[pos - 1] = true;
    this.set[pos - 1] = done;
  }
  exactValue(width: number): string | null {
    if (!this.known.slice(0, width).some(Boolean)) return null;
    let bits = "";
    for (let i = 0; i < width; i++) bits += this.set[i] ? "1" : "0";
    return bits;
  }
}

const ZONE_HEADER_PREFIX = "--- ";
const ZONE_HEADER_SUFFIX = " ---";
const TIER_COMPLETE_PREFIX = "Tier complete: ";

const NOTICE_LINES = new Set([
  "Details: #popflags 1, 2, 3, 4, or 5 (tier1-tier5 also work).",
  "A checklist memory is ready to be unlocked.",
  "Sit near Seer Mal Nae`Shi and say 'unlock memories', then check #popflags again.",
  "Pending checklist memories exist, but their prerequisite steps are incomplete.",
  "Complete the unfinished progression shown above, then return to Seer Mal Nae`Shi.",
  "If one of these is missing, hail Maelin and ask about new lore and new information.",
  // Printed under the Miak preflag line while it's Missing (PR #487).
  "Speak to Miak the Searedsoul in Tranquility about 'portal's destination'; hailing alone does not grant the preflag.",
  "Complete the elemental progression, combine the four elemental essences, and return to Grand Librarian Maelin.",
]);

function isZoneHeaderLine(line: string): boolean {
  return (
    line.startsWith(ZONE_HEADER_PREFIX) &&
    line.endsWith(ZONE_HEADER_SUFFIX) &&
    line.length > ZONE_HEADER_PREFIX.length + ZONE_HEADER_SUFFIX.length
  );
}

function matchPending(line: string): string | null {
  const prefix = "Pending memory: ";
  if (!line.startsWith(prefix)) return null;
  return PENDING_DESC[line.slice(prefix.length)] ?? null;
}

function matchBitLine(line: string, hoh: BitState, sol: BitState): boolean {
  for (const b of BIT_LINES) {
    const prefix = `${b.label}: `;
    if (!line.startsWith(prefix)) continue;
    const rest = line.slice(prefix.length);
    if (rest !== "Complete" && rest !== "Incomplete") return false;
    (b.qglobal === "hohtrials" ? hoh : sol).apply(b.pos, rest === "Complete");
    return true;
  }
  return false;
}

function applyStageRest(r: PopFlagsReport, qglobal: string, stages: string[], rest: string): boolean {
  if (rest === "Not started") {
    r.exact[qglobal] = "";
    return true;
  }
  const i = stages.indexOf(rest);
  if (i < 0) return false;
  r.exact[qglobal] = String(i + 1);
  return true;
}

function matchStageLine(r: PopFlagsReport, line: string): boolean {
  for (const sl of STAGE_LABELS) {
    const prefix = `${sl.label}: `;
    if (line.startsWith(prefix)) {
      const rest = line.slice(prefix.length);
      if (!applyStageRest(r, sl.qglobal, sl.stages, rest) && sl.legacy) {
        applyStageRest(r, sl.qglobal, sl.legacy, rest);
      }
      return true;
    }
  }
  for (const kl of KARANA_LABELS) {
    const prefix = `${kl.label}: `;
    if (line.startsWith(prefix)) {
      const rest = line.slice(prefix.length);
      if (rest === "Complete; combined into Zebuxoruk lore") setAtLeast(r, "zebuxoruk", 1);
      else applyStageRest(r, "karana", kl.stages, rest);
      return true;
    }
  }
  return false;
}

// Whether a single message (timestamp already stripped) is part of a
// '#popflags' report. Must recognize every line the command can print,
// including ones carrying no state, or a block would be cut mid-report.
export function matchPopFlagsLine(raw: string): boolean {
  const line = raw.trim();
  if (!line) return false;
  if (line in HEADERS) return true;
  if (isZoneHeaderLine(line)) return true;
  if (line.startsWith(TIER_COMPLETE_PREFIX)) return true;
  if (NOTICE_LINES.has(line)) return true;
  if (line in LITERAL_LINES) return true;
  if (matchPending(line)) return true;
  if (matchBossLine(newReport(), line)) return true;
  if (matchBitLine(line, new BitState(), new BitState())) return true;
  return matchStageLine(newReport(), line);
}

// Parse one buffered block (message text only, in printed order).
export function parsePopFlagsReport(lines: string[]): PopFlagsReport {
  const r = newReport();
  const hoh = new BitState();
  const sol = new BitState();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const section = HEADERS[line];
    if (section) {
      r.section = section;
      continue;
    }
    const effect = LITERAL_LINES[line];
    if (effect) {
      effect(r);
      continue;
    }
    const pend = matchPending(line);
    if (pend) {
      r.pending[pend] = true;
      continue;
    }
    if (matchBossLine(r, line)) continue;
    if (matchBitLine(line, hoh, sol)) continue;
    matchStageLine(r, line);
    // Zone sub-headers, "Tier complete: ..." lore, notices: no state.
  }

  const h = hoh.exactValue(3);
  if (h !== null) r.exact["hohtrials"] = h;
  const s = sol.exactValue(5);
  if (s !== null) r.exact["sol_room"] = s;
  return r;
}

// EQ log line: "[Thu Sep 10 20:15:03 2026] message". Strips the timestamp; a
// line without one is treated as a bare message so a paste copied without
// timestamps works too.
const LOG_TS = /^\[[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}\] /;

export function stripLogTimestamp(line: string): string {
  return line.replace(/\r$/, "").replace(LOG_TS, "");
}

// Extract every '#popflags' block from pasted log text. A block is a run of
// consecutive matching lines (a non-matching line ends it, mirroring the live
// consumer/scan in pq-companion); a new "=== ... ===" header also starts a new
// block so back-to-back reports in one paste stay separate.
export function extractPopFlagsBlocks(text: string): string[][] {
  const blocks: string[][] = [];
  let cur: string[] = [];
  const flush = () => {
    if (cur.length > 0) blocks.push(cur);
    cur = [];
  };
  for (const raw of text.split("\n")) {
    const msg = stripLogTimestamp(raw).trim();
    if (msg && matchPopFlagsLine(msg)) {
      if (msg in HEADERS) flush();
      cur.push(msg);
    } else {
      flush();
    }
  }
  flush();
  return blocks.filter((b) => b.some((l) => l in HEADERS));
}

// Merge several parsed blocks into one qglobal map (later blocks win for
// exact values; floors only ever raise), ready for deriveCompletion().
export function mergeReportsToQglobals(reports: PopFlagsReport[]): Record<string, string> {
  const q: Record<string, string> = {};
  for (const r of reports) {
    for (const [k, v] of Object.entries(r.exact)) q[k] = v;
  }
  for (const r of reports) {
    for (const [k, floor] of Object.entries(r.atLeast)) {
      const cur = parseInt(q[k] ?? "", 10);
      if (Number.isNaN(cur) || cur < floor) q[k] = String(floor);
    }
    for (const k of Object.keys(r.pending)) q[k] = "1";
  }
  return q;
}
