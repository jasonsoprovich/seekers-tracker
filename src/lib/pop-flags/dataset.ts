// The curated Planes of Power flag dataset, ported from pq-companion's
// backend/internal/popflag package. flags.json (src/data/pop-flags.json) is
// the single source of truth, copied verbatim from that repo — see
// docs/guild-website-feasibility.md §4 for the reuse rationale and §10 for
// the post-PoP-launch Seer text reconciliation caveat.

import flagsData from "@/data/pop-flags.json";

// A live-log signal (pq-companion Phase 3 — not wired up here) that would
// optimistically mark a flag complete from a kill/zone/say/loot event.
// Carried through so the dataset stays byte-for-byte compatible with
// pq-companion's flags.json; unused until this site has a live-log import.
export interface EventRule {
  kind: string;
  match: string;
}

// An alternate qglobal condition that also marks a flag complete — the
// cipher/zebuxoruk replacement any-of (see seer.ts for the semantics).
export interface QualifyCond {
  qglobal: string;
  value: string;
}

// One discrete progression flag (a node in the dependency DAG).
export interface PoPFlag {
  id: string;
  tier: number;
  zone: string;
  zone_short: string;
  label: string;
  detail: string;
  prereqs: string[];
  level?: number;

  // Not required for THIS character's personal flagging (raid door keys,
  // keyring zone-ins, purely optional content). Excluded from done/total
  // tallies and never another flag's prereq.
  optional?: boolean;

  // "key" | "keyring" | "optional" — why a row is special, for a badge
  // distinct from step_kind's action bucket. A non-empty role implies
  // optional.
  role?: string;

  // The ID of the anchor flag this any-of alternative rolls up to.
  // Completing any member marks the anchor done; unchosen members render
  // superseded. Members are display granularity only.
  group?: string;

  // "kill" | "timed_hail" | "hail" | "loot" — the action a player must
  // take, for UI colour-coding/icons.
  step_kind?: string;

  // Completion detection, consumed by the Seer parser (seer.ts).
  qglobal?: string;
  qglobal_value?: string;
  counter?: boolean;
  bit_position?: number;
  satisfied_by?: QualifyCond[];
  seer_phrases?: string[];
  events?: EventRule[];
}

const flags = flagsData as PoPFlag[];

const byId = new Map(flags.map((f) => [f.id, f]));

// All curated PoP flags in dataset order.
export function getFlags(): PoPFlag[] {
  return flags;
}

// The flag with the given ID, or undefined if it doesn't exist.
export function getFlagById(id: string): PoPFlag | undefined {
  return byId.get(id);
}
