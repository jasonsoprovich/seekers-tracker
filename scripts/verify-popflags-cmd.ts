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

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
