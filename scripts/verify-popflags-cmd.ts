// Verifies the #popflags parser port (src/lib/pop-flags/popflags-cmd.ts) against
// cases ported from pq-companion's popflags_cmd_test.go, plus the full paste ->
// blocks -> qglobals -> deriveCompletion path with real-looking log lines.
// Pure (no DB). Usage: npx tsx scripts/verify-popflags-cmd.ts
import {
  deriveCompletion,
  extractPopFlagsBlocks,
  matchPopFlagsLine,
  mergeReportsToQglobals,
  parsePopFlagsReport,
} from "../src/lib/pop-flags";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
}

const tier1 = [
  "=== Tier 1 Progression ===",
  "--- Plane of Justice ---",
  "Mavuin's case: Mavuin's case is complete",
  "Seventh Hammer access: Unlocked",
  "--- Plane of Disease ---",
  "Fuirstel progression: Crypt of Decay access was granted",
  "Crypt of Decay access: Unlocked",
  "Pending memory: Grummus",
  "--- Plane of Nightmare ---",
  "Thelin progression: Terris Thule was defeated",
  "Pending memory: Thelin's hedge maze",
  "--- Plane of Innovation ---",
  "Factory door access: Locked",
  "Giwin and Manaetic Behemoth progression: Not started",
  "Tier complete: Justice has been served, Disease's grip weakened, Nightmare ended, and Innovation's hidden plot uncovered.",
];
const r1 = parsePopFlagsReport(tier1);
check("tier1 section", r1.section === "tier1");
check("tier1 mavuin=3", r1.exact.mavuin === "3");
check("tier1 seventh=1", r1.exact.seventh === "1");
check("tier1 fuirstel=4", r1.exact.fuirstel === "4");
check("tier1 grummus=1", r1.exact.grummus === "1");
check("tier1 thelin=3", r1.exact.thelin === "3");
check("tier1 poi_door absent", r1.exact.poi_door === "");
check("tier1 zeks absent", r1.exact.zeks === "");
check("tier1 pending", !!r1.pending.cl_grummus && !!r1.pending.cl_maze);

const bits = parsePopFlagsReport([
  "=== Tier 3 Progression ===",
  "--- Halls of Honor ---",
  "Rydda`Dar trial: Complete",
  "Village trial: Incomplete",
  "Nomad trial: Complete",
  "Mithaniel Marr cipher half: Incomplete",
  "--- Tower of Solusek Ro ---",
  "Xuzl: Complete",
  "Arlyxir: Incomplete",
  "Dresolik: Incomplete",
  "Rizlona: Complete",
  "Jiva: Incomplete",
]);
check("bitmask hohtrials=101", bits.exact.hohtrials === "101", bits.exact.hohtrials);
check("bitmask sol_room=10010", bits.exact.sol_room === "10010", bits.exact.sol_room);
check("mmarr absent", bits.exact.mmarr === "");

const ov = parsePopFlagsReport([
  "=== Planes of Power Progression ===",
  "Tier 1: Complete",
  "Tier 2: In progress",
  "Tier 3: Not started",
  "Tier 4: Not started",
  "Tier 5 - Plane of Time: Not started",
  "Details: #popflags 1, 2, 3, 4, or 5 (tier1-tier5 also work).",
]);
check("overview section", ov.section === "overview");
check("overview floors", ov.atLeast.mavuin === 3 && ov.atLeast.fuirstel === 5 && ov.atLeast.thelin === 4);
check("tier2 in-progress adds nothing", !("aerindar" in ov.exact));

check("recognizes zone header", matchPopFlagsLine("--- Plane of Justice ---"));
check("recognizes notice", matchPopFlagsLine("A checklist memory is ready to be unlocked."));
check("rejects chatter", !matchPopFlagsLine("You say, 'hello'"));

// Full paste: timestamps, chatter in between, two reports back to back.
const paste = [
  "[Thu Oct 02 20:15:03 2026] You say, '#popflags 1'",
  ...tier1.map((l, i) => `[Thu Oct 02 20:15:0${(i % 9) + 1} 2026] ${l}`),
  "[Thu Oct 02 20:16:00 2026] You have entered Plane of Knowledge.",
  "[Thu Oct 02 20:16:10 2026] === Planes of Power Progression ===",
  "[Thu Oct 02 20:16:10 2026] Tier 1: Complete",
  "[Thu Oct 02 20:16:10 2026] Tier 2: In progress",
].join("\n");
const blocks = extractPopFlagsBlocks(paste);
check("two blocks extracted", blocks.length === 2, String(blocks.length));
const q = mergeReportsToQglobals(blocks.map(parsePopFlagsReport));
const done = new Set(deriveCompletion(q));
check("derived: justice case done", done.has("poj_mavuin") || [...done].some((id) => id.startsWith("poj_")), [...done].join(","));
console.log("derived flags:", [...done].join(", "));

// Safety: an all-"Not started" report must derive nothing.
const none = mergeReportsToQglobals([
  parsePopFlagsReport([
    "=== Planes of Power Progression ===",
    "Tier 1: Not started",
    "Tier 2: Not started",
    "Tier 3: Not started",
    "Tier 4: Not started",
  ]),
]);
check("not-started report derives nothing", deriveCompletion(none).length === 0, deriveCompletion(none).join(","));

// Giwin Mirakon preflag completes from the zeks counter (pq-companion 398eacf2).
const giwinYes = mergeReportsToQglobals([
  parsePopFlagsReport([
    "=== Tier 1 Progression ===",
    "--- Plane of Innovation ---",
    "Giwin and Manaetic Behemoth progression: Progress recorded",
  ]),
]);
check("giwin progress recorded -> poi_preflag", deriveCompletion(giwinYes).includes("poi_preflag"));
const giwinNo = mergeReportsToQglobals([
  parsePopFlagsReport([
    "=== Tier 1 Progression ===",
    "--- Plane of Innovation ---",
    "Giwin and Manaetic Behemoth progression: Not started",
  ]),
]);
check("giwin not started -> no poi_preflag", !deriveCompletion(giwinNo).includes("poi_preflag"));

// PR #487 (2026-10-22) wording: boss status lines + reworded Fuirstel stages.
const tier1New = [
  "=== Tier 1 Progression ===",
  "--- Plane of Disease ---",
  "Fuirstel progression: Elder Fuirstel aided; defeat Bertoxxulous",
  "Crypt of Decay access: Unlocked",
  "Grummus flag: Complete",
  "--- Plane of Nightmare ---",
  "Thelin progression: Help Thelin escape the hedge maze",
  "Pending memory: Thelin's hedge maze",
  "Terris Thule flag: Missing",
  "--- Plane of Innovation ---",
  "Factory door access: Locked",
  "Manaetic Behemoth flag: Complete",
];
check("#487 tier1 every line recognized", tier1New.every(matchPopFlagsLine));
const n1 = parsePopFlagsReport(tier1New);
check("#487 fuirstel=3", n1.exact.fuirstel === "3", n1.exact.fuirstel);
check("#487 grummus memory cleared", n1.exact.cl_grummus === "" && !n1.pending.cl_grummus);
check("#487 behemoth -> zeks>=2", n1.atLeast.zeks === 2);
check("#487 behemoth -> poi_mb", deriveCompletion(mergeReportsToQglobals([n1])).includes("poi_mb"));
check("#487 legacy fuirstel still parses", r1.exact.fuirstel === "4");

const t3New = parsePopFlagsReport([
  "=== Tier 3 Progression ===",
  "Mithaniel Marr cipher half: Complete",
  "Mithaniel Marr book: Missing",
  "Agnarr / Karana flag: Pending memory",
  "Miak the Searedsoul preflag: Missing",
  "Speak to Miak the Searedsoul in Tranquility about 'portal's destination'; hailing alone does not grant the preflag.",
]);
check("#487 mmarr floor", t3New.atLeast.mmarr === 1);
check("#487 book absent", t3New.exact.mmarr_book === "");
check("#487 karana pending", !!t3New.pending.cl_karana);
check(
  "#487 miak hint recognized",
  matchPopFlagsLine(
    "Speak to Miak the Searedsoul in Tranquility about 'portal's destination'; hailing alone does not grant the preflag.",
  ),
);
const t2New = parsePopFlagsReport(["=== Tier 2 Progression ===", "Saryrn cipher half: Complete"]);
check("#487 saryrn complete -> potor_saryrn", deriveCompletion(mergeReportsToQglobals([t2New])).includes("potor_saryrn"));

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
