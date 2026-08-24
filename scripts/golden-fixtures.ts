// Curated fixture set for the EPGP verification harness
// (scripts/verify-harness.ts) — PLAN.md §5 / Phase 0 task 0.7. Selected to
// exercise specific edge cases in computeEpgpTotals, not sampled randomly.
//
// `expected` values are the guild's own cached numbers, read directly off
// "SoS - EPGP.xlsx" on 2026-08-21:
//   - Most characters: Totals!F/G/I/J/H (Effort Points, Gear Points, EP
//     Decay, GP Decay, Loot Priority).
//   - The three GP-only departed characters have no Totals row at all (see
//     PLAN.md §1e) — their expected GP is summed directly from the GP Log
//     tab instead, split on the current cycle boundary and decayed the same
//     way Totals!I/J would, and cross-checked against this repo's own local
//     D1 gp_ledger sums (75 / 0 / 385 raw GP for Droctulft/Aragore/Aylah).
//
// Re-verify against a fresh sheet export if these ever drift — the sheet is
// the source of truth, not this file.
//
// PLAN.md §11 Phase 3 task 3.11 note: computeEpgpTotals groups by
// player_id, not character_id, since Toryn's real bot dump landed
// (2026-08-23) and every character now has a real players.id. This
// retired the original "departed-gp-only" Beguilez fixture — she turned
// out to be a real alt (of Khrathak, player id 49, alongside Valerion) in
// Toryn's dump, so her total now correctly includes Valerion's GP too and
// no longer matches her old solo-character expectation. Swapped in
// Droctulft (same 75-raw-GP/no-decay profile, but genuinely a
// single-character player) to keep that category testing what it always
// tested, and turned Beguilez's case into the "main-alt-pair" fixture
// below instead — a real one, not invented: two independently-sourced GP
// Log rows (75 + 100, both plain non-decay rows, verified above) combined
// via the same decay formula already verified against Aazimoku/Aransur/
// Ammaru elsewhere in this file, grouped by a real Discord account from
// Toryn's dump rather than a guess.

export type Expected = {
  ep: number;
  gp: number;
  epDecay: number;
  gpDecay: number;
  priority: number;
};

export type GoldenFixture = {
  name: string;
  category: string;
  note: string;
  expected: Expected;
};

// Sheet displays are rounded to sheet precision; computeEpgpTotals runs at
// full float precision. This absorbs that, not real drift.
export const TOLERANCE = 0.05;

export const GOLDEN_FIXTURES: GoldenFixture[] = [
  {
    name: "Aazimoku",
    category: "veteran-all-3-expansion-decays",
    note: "Spans all three historical expansion decay events (PLAN.md §1b) and is well above the base-EP floor.",
    expected: { ep: 2478.4, gp: 252.6, epDecay: 619.6, gpDecay: 63.15, priority: 7.4543 },
  },
  {
    name: "Aransur",
    category: "veteran-all-3-expansion-decays",
    note: "Guild's top-end lifetime EP (~17.7K raw) — verified against Totals!I4 in PLAN.md §1a.",
    expected: { ep: 14032.56, gp: 1145.8, epDecay: 3458.14, gpDecay: 261.45, priority: 11.3843 },
  },
  {
    name: "Ammaru",
    category: "veteran-all-3-expansion-decays",
    note: "Third of the three characters PLAN.md §1a verifies the legacy cycle-decay formula against.",
    expected: { ep: 7881.68, gp: 993.48, epDecay: 1932.92, gpDecay: 248.37, priority: 7.3451 },
  },
  {
    name: "Aiyana",
    category: "under-base-floor-exemption",
    note: "Lifetime EP (34) is under base_ep (150) — decay must be 0, not 20% of a tiny pre-cycle balance.",
    expected: { ep: 34.1, gp: 14.73, epDecay: 0, gpDecay: 0, priority: 1.6046 },
  },
  {
    name: "Asheel",
    category: "under-base-floor-exemption",
    note: "Lifetime EP (76) under base_ep (150) — same floor-exemption check as Aiyana.",
    expected: { ep: 75.95, gp: 11.03, epDecay: 0, gpDecay: 0, priority: 2.035 },
  },
  {
    name: "Asmond",
    category: "under-base-floor-exemption",
    note: "Lifetime EP (106) under base_ep (150) — same floor-exemption check as Aiyana.",
    expected: { ep: 106.5, gp: 15, epDecay: 0, gpDecay: 0, priority: 2.2304 },
  },
  {
    name: "Takkisina",
    category: "frequently-cap-limited",
    note: "139 historical cap-limited cycle rows (PLAN.md §5 table) — cap logic itself isn't tested until Phase 2/3, but this exercises a large, decay-heavy ledger.",
    expected: { ep: 13433.36, gp: 1479.56, epDecay: 3320.84, gpDecay: 369.89, priority: 8.5995 },
  },
  {
    name: "Luna",
    category: "frequently-cap-limited",
    note: "125 historical cap-limited rows, including cycle 6 = 1,310 recorded (over the 900 cap) per PLAN.md §2 — the over-cap example itself needs a per-cycle query Phase 0 doesn't have yet, but the character-level total is a fixture here now.",
    expected: { ep: 11751.88, gp: 655.12, epDecay: 2900.47, gpDecay: 163.78, priority: 15.7616 },
  },
  {
    name: "Kaalos",
    category: "cap-exceeded-historically",
    note: "Cycle 1 recorded 1,200 (over the 900 cap) per PLAN.md §2. Same caveat as Luna re: per-cycle assertions.",
    expected: { ep: 10981.72, gp: 1385.8, epDecay: 2695.43, gpDecay: 346.45, priority: 7.4921 },
  },
  {
    name: "Droctulft",
    category: "departed-gp-only",
    note: "GP-log-only character (no EP Log row, no Totals row) per PLAN.md §1e. Raw GP (75) is under base_gp — no decay. Genuinely a single-character player (no dump siblings), unlike Beguilez.",
    expected: { ep: 0, gp: 75, epDecay: 0, gpDecay: 0, priority: 0.8571 },
  },
  {
    name: "Beguilez",
    category: "main-alt-pair",
    note: "Real main/alt pair from Toryn's dump (task 3.1/3.4): Beguilez (75 GP) is an alt of Khrathak, alongside Valerion (100 GP) — player id 49. Combined raw GP 175, all pre-cycle, decayed 20% -> 140/35. Neither has any EP.",
    expected: { ep: 0, gp: 140, epDecay: 0, gpDecay: 35, priority: 0.625 },
  },
  {
    name: "Aragore",
    category: "departed-gp-only",
    note: "GP-log-only character with a single 0-point row — exercises the zero/zero edge of the priority formula.",
    expected: { ep: 0, gp: 0, epDecay: 0, gpDecay: 0, priority: 1.5 },
  },
  {
    name: "Aylah",
    category: "departed-gp-only",
    note: "GP-log-only character above base_gp — the one departed fixture that actually exercises GP decay with no EP present at all.",
    expected: { ep: 0, gp: 308, epDecay: 0, gpDecay: 77, priority: 0.3676 },
  },
];

// Categories named in PLAN.md §5 that don't have a computeEpgpTotals-level
// assertion yet — either the schema column they need doesn't exist until a
// later phase, or they need a per-cycle query this Phase-0 harness doesn't
// do. Listed here (and echoed by verify-harness.ts) so the candidates stay
// documented and aren't lost, without inventing an assertion the code can't
// support yet.
export const DEFERRED_FIXTURES: { category: string; note: string }[] = [
  {
    category: "cap-exceeded-historically (per-cycle)",
    note: "Luna cycle 6 (recorded 1,310) and Kaalos cycle 1 (recorded 1,200) — needs a per-cycle awarded-points query. The columns it would read (points_nominal/points_awarded/cap_applied) landed in task 3.7/3.8 and are populated (324 ep_ledger rows have cap_applied=1 as of the real dump import); still just needs the per-cycle assertion itself written.",
  },
  {
    category: "orphaned-nameless-ep-rows",
    note: "1,637 EP Log rows with the character name stripped (PLAN.md §1e). The `orphaned` column and player_id-nullable ledger rows landed in task 3.9, but computeEpgpTotals already excludes them by construction (NULL player_id) — no per-row assertion added here yet, since there's nothing sheet-verifiable to check an orphaned row's own value against (see scripts/import-epgp.ts's comment on why it's 0).",
  },
];
