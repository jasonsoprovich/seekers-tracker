// The single registry every permission gate in the app reads from —
// src/lib/authz.ts's canManageAnyCharacter/canManageRoles/canManageEpgp/
// canManageEpgpConfig used to hardcode these tiers; this file is their
// replacement, made admin-tunable via the role_permissions table
// (src/db/schema.ts) instead of requiring a deploy to change.
//
// Deliberately dependency-free (no `next/headers`, no drizzle import) so
// custom-worker.ts can import it the same way it already imports
// src/lib/view-as.ts — see that file's own comment for why the split
// matters (a Route Handler runs inside OpenNext's Node loopback; the raw
// Worker entry point does not).

export const MATRIX_ROLES = ["member", "officer", "leader"] as const;
export type MatrixRole = (typeof MATRIX_ROLES)[number];

export function isMatrixRole(value: string): value is MatrixRole {
  return (MATRIX_ROLES as readonly string[]).includes(value);
}

export type CapabilityGroup =
  | "Roster & Characters"
  | "Membership"
  | "EPGP"
  | "Admin Area";

export type CapabilityDef = {
  group: CapabilityGroup;
  label: string;
  description: string;
  // The role tiers this capability is granted to out of the box — chosen to
  // reproduce each gate's pre-registry behavior exactly, except
  // "members.remove" (see its own comment) and "characters.create.forOther"
  // (new capability, no prior gate to match).
  defaults: readonly MatrixRole[];
  // Roles whose checkbox is disabled in the editor and rejected server-side
  // even if the request is forged — reserved for capabilities destructive
  // or sensitive enough that handing them to every member by mistake would
  // be hard to walk back cleanly (guild removal, role/main changes, EPGP
  // config, decay, raid reversal, credentialed tooling).
  lockedRoles?: readonly MatrixRole[];
};

// Capability keys are stable identifiers stored in role_permissions rows —
// renaming one here orphans any existing override row for it (harmless:
// applyOverrides ignores rows whose capability isn't in this registry, so
// it just silently reverts to the new key's default; still, prefer adding a
// new key over renaming one with real overrides in production).
export const CAPABILITIES = {
  // --- Roster & Characters -------------------------------------------
  "characters.manageAny": {
    group: "Roster & Characters",
    label: "Edit any member's characters",
    description: "View and edit any character's sheet, gear, stats, and PoP flags — not just your own.",
    defaults: ["officer", "leader"],
  },
  "characters.link": {
    group: "Roster & Characters",
    label: "Link / unlink characters on any account",
    description: "Attach an existing roster character to a member's account, or detach one back to standalone.",
    defaults: ["officer", "leader"],
  },
  "characters.create.forOther": {
    group: "Roster & Characters",
    label: "Add a new alt to another member's account",
    description: "Create a brand-new character (alt or mule) directly on someone else's account from their Account page.",
    defaults: ["officer", "leader"],
  },
  "characters.retype": {
    group: "Roster & Characters",
    label: "Change a character's type (alt / mule)",
    description: "Retype a character between alt and mule. Promoting to main is a separate, leader-only main swap.",
    defaults: ["officer", "leader"],
  },
  "characters.officerTag": {
    group: "Roster & Characters",
    label: "Toggle a character's in-game officer tag",
    description: "Mark whether a specific alt/mule displays the account's officer role on Roster.",
    defaults: ["officer", "leader"],
  },
  "claims.review": {
    group: "Roster & Characters",
    label: "Review character claim requests",
    description: "Approve or deny a member's request to claim an unclaimed roster character.",
    defaults: ["officer", "leader"],
  },
  "members.assignCharacter": {
    group: "Roster & Characters",
    label: "Assign a character in the account setup queue",
    description: "Attach an unclaimed roster character to a verified Discord member who has none yet.",
    defaults: ["officer", "leader"],
  },

  // --- Membership -------------------------------------------------------
  "members.remove": {
    group: "Membership",
    label: "Remove / reinstate a member from the guild",
    description: "Zero a departing member's EP, lock their site access, and — separately — reinstate them later. GP is never touched.",
    // Changed from the pre-registry leader-only gate at the guild leader's
    // explicit request (2026-09-19): officers get the same removal power
    // leader/admin already have.
    defaults: ["officer", "leader"],
    lockedRoles: ["member"],
  },
  "members.role.manage": {
    group: "Membership",
    label: "Promote / demote account roles",
    description: "Change a member's site and guild role. Capped at your own role — see the rank ceiling in setUserRole.",
    defaults: ["leader"],
    lockedRoles: ["member"],
  },
  "members.main.swap": {
    group: "Membership",
    label: "Set or repair an account's main character",
    description: "Force a main-character swap (500 GP fee, waivable) or repair a drifted main pointer.",
    defaults: ["leader"],
    lockedRoles: ["member"],
  },

  // --- EPGP ---------------------------------------------------------------
  "epgp.ledger.manage": {
    group: "EPGP",
    label: "Enter and edit EP/GP ledger rows",
    description: "Add, edit, or delete manual EP/GP ledger entries and bids from the website.",
    defaults: ["officer", "leader"],
  },
  "epgp.raids.manage": {
    group: "EPGP",
    label: "Name and annotate raids",
    description: "Set a raid's display name and notes on the Raids & Events page.",
    defaults: ["officer", "leader"],
  },
  "epgp.info.edit": {
    group: "EPGP",
    label: "Edit Cycle & Rules Info pages",
    description: "Edit the prose sections shown on the member-facing Cycle & Rules Info page.",
    defaults: ["officer", "leader"],
  },
  "epgp.bank.manage": {
    group: "EPGP",
    label: "Manage Sky Bank holdings",
    description: "Add, edit, or remove guild bank inventory rows.",
    defaults: ["officer", "leader"],
  },
  "epgp.officerApi": {
    group: "EPGP",
    label: "Use the officer desktop app (API key)",
    description: "Authenticate the EverQuest log-parser desktop app against the website's officer API. Kept separate from ledger access so a demotion still revokes keys correctly.",
    defaults: ["officer", "leader"],
    lockedRoles: ["member"],
  },
  "epgp.appKey": {
    group: "EPGP",
    label: "Generate / revoke your own app key",
    description: "Manage your own officer API key at /epgp/app-key.",
    defaults: ["officer", "leader"],
    lockedRoles: ["member"],
  },
  "epgp.sql": {
    group: "EPGP",
    label: "Run the read-only SQL sandbox",
    description: "Run ad-hoc read-only SQL queries against the EPGP tables.",
    defaults: ["officer", "leader"],
    lockedRoles: ["member"],
  },
  "epgp.raids.reverse": {
    group: "EPGP",
    label: "Reverse a whole raid",
    description: "Undo every ledger row a raid produced in one action.",
    defaults: ["leader"],
    lockedRoles: ["member"],
  },
  "epgp.config": {
    group: "EPGP",
    label: "Change EPGP settings",
    description: "Tune base EP/GP, decay rate, the per-cycle cap, and other effective-dated guild constants; rebuild standings.",
    defaults: ["leader"],
    lockedRoles: ["member"],
  },
  "epgp.decay": {
    group: "EPGP",
    label: "Preview, commit, or reverse decay",
    description: "Run cycle decay and departure EP wipes, and reverse them.",
    defaults: ["leader"],
    lockedRoles: ["member"],
  },
  "epgp.liveBids.visibility": {
    group: "EPGP",
    label: "Hide / show live collecting rounds",
    description: "Control whether open bid rounds are visible on the member live-bids feed while they're being collected.",
    defaults: ["leader"],
    lockedRoles: ["member"],
  },

  // --- Admin Area -----------------------------------------------------
  "admin.view": {
    group: "Admin Area",
    label: "See the Admin area",
    description: "Reach /admin at all, and see it in the nav.",
    defaults: ["officer", "leader"],
  },
  "admin.health.view": {
    group: "Admin Area",
    label: "View System Health",
    description: "Read-only standings/backup/restore-point status at /admin/health.",
    defaults: ["officer", "leader"],
  },
  "admin.imports.view": {
    group: "Admin Area",
    label: "View the Import Audit Trail",
    description: "Read-only history of processed imports.",
    defaults: ["officer", "leader"],
  },
} as const satisfies Record<string, CapabilityDef>;

export type Capability = keyof typeof CAPABILITIES;
export const CAPABILITY_KEYS = Object.keys(CAPABILITIES) as Capability[];

// `as const satisfies` above narrows each entry to its OWN literal type
// (e.g. one with no `lockedRoles` key at all, rather than `lockedRoles?:
// undefined`), so `CAPABILITIES[key]` for a generic `key: Capability`
// widens to a union that TS won't let you read an optional field off
// directly. This forces it back to the declared CapabilityDef shape —
// structurally valid, since every entry does satisfy that type.
export function capabilityDef(key: Capability): CapabilityDef {
  return CAPABILITIES[key];
}

export function isCapability(value: string): value is Capability {
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, value);
}

export const CAPABILITY_GROUP_ORDER: readonly CapabilityGroup[] = [
  "Roster & Characters",
  "Membership",
  "EPGP",
  "Admin Area",
];

export function capabilitiesByGroup(): { group: CapabilityGroup; capabilities: Capability[] }[] {
  return CAPABILITY_GROUP_ORDER.map((group) => ({
    group,
    capabilities: CAPABILITY_KEYS.filter((key) => CAPABILITIES[key].group === group),
  }));
}

// One row per (capability, matrix role) override, as read from the
// role_permissions table — kept generic over the row shape rather than
// importing the Drizzle table type here, so this file stays free of any db
// dependency.
export type OverrideRow = { capability: string; role: string; allowed: boolean };

export type PermissionMatrix = Record<Capability, Record<MatrixRole, boolean>>;

export function defaultMatrix(): PermissionMatrix {
  const matrix = {} as PermissionMatrix;
  for (const key of CAPABILITY_KEYS) {
    // `as const satisfies` above narrows each entry's `defaults` to its own
    // literal tuple type (e.g. readonly ["leader"]) rather than the widened
    // readonly MatrixRole[] this loop needs — widen it back explicitly.
    const defaults = CAPABILITIES[key].defaults as readonly MatrixRole[];
    matrix[key] = {
      member: defaults.includes("member"),
      officer: defaults.includes("officer"),
      leader: defaults.includes("leader"),
    };
  }
  return matrix;
}

// Applies stored overrides on top of the registry defaults. Rows for an
// unknown capability or role are ignored (e.g. a capability key that was
// since renamed/removed) — never throws on stale data.
export function applyOverrides(rows: readonly OverrideRow[]): PermissionMatrix {
  const matrix = defaultMatrix();
  for (const row of rows) {
    if (!isCapability(row.capability) || !isMatrixRole(row.role)) continue;
    matrix[row.capability][row.role] = row.allowed;
  }
  return matrix;
}

// The one place every gate calls through. `admin` is always true — a
// superset of every capability, mirroring how every pre-registry
// canManage*() already treated it — and is never itself a matrix column, so
// there's nothing to look up or override for it. A null role (signed out,
// or a role string the matrix doesn't recognize) is always false.
export function roleCan(matrix: PermissionMatrix, role: string | null, capability: Capability): boolean {
  if (role === "admin") return true;
  if (role === null || !isMatrixRole(role)) return false;
  return matrix[capability][role];
}
