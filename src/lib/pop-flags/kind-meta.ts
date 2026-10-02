// Display metadata for a flag's step_kind/role badges, ported from
// pq-companion's frontend/src/lib/popFlagKind.ts (text-only here — no icon
// library dependency in this repo).

export type StepKind = "kill" | "timed_hail" | "hail" | "loot" | "zone";

interface StepKindMeta {
  label: string;
  className: string;
  tip: string;
}

export const STEP_KIND_META: Record<StepKind, StepKindMeta> = {
  kill: {
    label: "Kill",
    className: "border-orange-800 bg-orange-950/40 text-orange-400",
    tip: "Boss fight — be present at the raid.",
  },
  timed_hail: {
    label: "Timed hail",
    className: "border-pink-800 bg-pink-950/40 text-pink-400",
    tip: "Limited-window hail right after a boss — act fast, easy to miss.",
  },
  hail: {
    label: "Hail",
    className: "border-violet-800 bg-violet-950/40 text-violet-400",
    tip: "Always-up NPC — homework you can do anytime.",
  },
  loot: {
    label: "Loot",
    className: "border-yellow-800 bg-yellow-950/40 text-yellow-400",
    tip: "Loot or turn-in items — homework you can do anytime.",
  },
  zone: {
    label: "Zone-in",
    className: "border-teal-800 bg-teal-950/40 text-teal-400",
    tip: "Zone into the next area to key-ring your personal access.",
  },
};

export function stepKindMeta(kind?: string): StepKindMeta | null {
  return kind && kind in STEP_KIND_META ? STEP_KIND_META[kind as StepKind] : null;
}

export type Role = "key" | "keyring" | "optional";

interface RoleMeta {
  label: string;
  className: string;
  tip: string;
}

export const ROLE_META: Record<Role, RoleMeta> = {
  key: {
    label: "1/raid",
    className: "border-sky-800 bg-sky-950/40 text-sky-400",
    tip: "A door key — only one person per raid needs it. Not required for your personal flag.",
  },
  keyring: {
    label: "Key-ring",
    className: "border-teal-800 bg-teal-950/40 text-teal-400",
    tip: "Zone in once to key-ring your personal access. Easy to skip, but worth doing.",
  },
  optional: {
    label: "Optional",
    className: "border-slate-700 bg-slate-800/40 text-slate-400",
    tip: "Optional content — not required to progress.",
  },
};

export function roleMeta(role?: string): RoleMeta | null {
  return role && role in ROLE_META ? ROLE_META[role as Role] : null;
}

// Left-to-right reading order of zone cards within each tier band in the Flow
// view, ported from pq-companion's popFlagKind.ts (Grimrose's hand-verified
// flagging chart). A zone not listed falls back to first-seen order, appended
// after the known zones.
export const ZONE_ORDER: string[] = [
  // Tier 1
  "Plane of Justice", "Plane of Disease", "Plane of Nightmares", "Plane of Innovation",
  // Tier 2
  "Plane of Valor", "Plane of Storms", "Crypt of Decay", "Plane of Torment",
  // Tier 3
  "Halls of Honor", "Bastion of Thunder", "Plane of Knowledge", "Plane of Tactics", "Tower of Solusek Ro",
  // Tier 4
  "Plane of Air", "Plane of Water", "Plane of Earth", "Plane of Fire",
  // Tier 5 (Plane of Time)
  "Plane of Time",
];

const ZONE_COLORS: Record<string, string> = {
  "Plane of Justice": "#eab308",
  "Plane of Disease": "#84cc16",
  "Plane of Nightmares": "#a78bfa",
  "Plane of Innovation": "#94a3b8",
  "Plane of Valor": "#fb923c",
  "Plane of Storms": "#facc15",
  "Crypt of Decay": "#65a30d",
  "Plane of Torment": "#c084fc",
  "Halls of Honor": "#fb923c",
  "Bastion of Thunder": "#facc15",
  "Plane of Knowledge": "#34d399",
  "Plane of Tactics": "#2dd4bf",
  "Tower of Solusek Ro": "#f87171",
  "Plane of Air": "#60a5fa",
  "Plane of Water": "#38bdf8",
  "Plane of Earth": "#a16207",
  "Plane of Fire": "#f87171",
  "Plane of Time": "#f5f5dc",
};

export function zoneColor(zone: string): string {
  return ZONE_COLORS[zone] ?? "#94a3b8";
}
