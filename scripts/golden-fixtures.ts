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
//     D1 gp_ledger sums (75 / 0 / 385 raw GP for Beguilez/Aragore/Aylah).
//
// Re-verify against a fresh sheet export if these ever drift — the sheet is
// the source of truth, not this file.

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
    name: "Beguilez",
    category: "departed-gp-only",
    note: "GP-log-only character (no EP Log row, no Totals row) per PLAN.md §1e. Raw GP (75) is under base_gp — no decay.",
    expected: { ep: 0, gp: 75, epDecay: 0, gpDecay: 0, priority: 0.8571 },
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
    note: "Luna cycle 6 (recorded 1,310) and Kaalos cycle 1 (recorded 1,200) — needs a per-cycle awarded-points query. Exercise once Phase 2/3 cap logic (points_nominal/points_awarded/cap_applied) lands.",
  },
  {
    category: "orphaned-nameless-ep-rows",
    note: "1,637 EP Log rows with the character name stripped (PLAN.md §1e). No `orphaned` column or player_id-nullable ledger row exists until Phase 3 task 3.9 — pick one of the 1,637 as a fixture once that lands.",
  },
  {
    category: "main-alt-pair",
    note: "Blocked on Toryn's MySQL dump (PLAN.md §14, Phase 3 task 3.1) — the sheet has no main/alt grouping to pick a pair from.",
  },
];
