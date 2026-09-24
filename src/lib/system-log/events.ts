// Stable registry of every action the System Log can record — same
// reasoning as src/lib/permissions/capabilities.ts's CAPABILITIES: an
// exhaustive category filter in the UI, one place to see every event kind
// that exists, and a typo becomes a type error instead of an unfiltered
// free-text value nothing else agrees on.
//
// Renaming a key here is safe going forward (existing rows just keep their
// old string and won't match SYSTEM_EVENTS[key] for display — same
// tradeoff CAPABILITIES' own comment describes for role_permissions rows).

export const SYSTEM_EVENT_CATEGORIES = [
  "membership",
  "roles",
  "characters",
  "permissions",
  "epgp",
  "bank",
  "claims",
  "system",
] as const;

export type SystemEventCategory = (typeof SYSTEM_EVENT_CATEGORIES)[number];

export function isSystemEventCategory(value: string): value is SystemEventCategory {
  return (SYSTEM_EVENT_CATEGORIES as readonly string[]).includes(value);
}

type SystemEventDef = { category: SystemEventCategory; label: string };

export const SYSTEM_EVENTS = {
  // --- Roles -----------------------------------------------------------
  "roles.user.change": { category: "roles", label: "Site role changed" },
  "roles.player.change": { category: "roles", label: "Account role changed" },

  // --- Membership --------------------------------------------------------
  "members.remove": { category: "membership", label: "Removed from guild" },
  "members.reinstate": { category: "membership", label: "Reinstated" },
  "members.main.swap": { category: "membership", label: "Main character swapped" },
  "members.main.swap.reverse": { category: "membership", label: "Main swap reversed" },

  // --- Characters --------------------------------------------------------
  "characters.create": { category: "characters", label: "Character created" },
  "characters.update": { category: "characters", label: "Character edited" },
  "characters.link": { category: "characters", label: "Character linked to account" },
  "characters.detach": { category: "characters", label: "Character detached" },
  "characters.remove": { category: "characters", label: "Alt or mule removed from guild" },
  "characters.retype": { category: "characters", label: "Character type changed" },
  "characters.officerTag": { category: "characters", label: "Officer tag toggled" },
  "characters.absorb": { category: "characters", label: "Standalone player absorbed" },

  // --- Claims --------------------------------------------------------
  "claims.request": { category: "claims", label: "Claim requested" },
  "claims.approve": { category: "claims", label: "Claim approved" },
  "claims.deny": { category: "claims", label: "Claim denied" },

  // --- Permissions --------------------------------------------------------
  "permissions.save": { category: "permissions", label: "Permission matrix saved" },
  "permissions.reset": { category: "permissions", label: "Permissions reset to defaults" },

  // --- EPGP --------------------------------------------------------
  "epgp.entry.create": { category: "epgp", label: "Manual EP/GP entry" },
  "epgp.entry.update": { category: "epgp", label: "Ledger row edited" },
  "epgp.entry.delete": { category: "epgp", label: "Ledger row deleted" },
  "epgp.setting.change": { category: "epgp", label: "EPGP setting changed" },
  "epgp.decay.commit": { category: "epgp", label: "Decay batch committed" },
  "epgp.decay.reverse": { category: "epgp", label: "Decay batch reversed" },
  "epgp.departure.commit": { category: "epgp", label: "Departure EP wipe" },
  "epgp.raid.reverse": { category: "epgp", label: "Raid reversed" },
  "epgp.raid.meta": { category: "epgp", label: "Raid renamed" },
  "epgp.info.update": { category: "epgp", label: "Rules info section edited" },
  "epgp.standings.rebuild": { category: "epgp", label: "Standings rebuilt" },
  // One summary row per parser submission, not per ledger line — the
  // per-row detail already lives on the EP/GP ledgers themselves.
  "epgp.bids.finalize": { category: "epgp", label: "Bid round recorded" },
  "epgp.attendance.submit": { category: "epgp", label: "Attendance capture submitted" },

  // --- Bank --------------------------------------------------------
  "bank.holding.create": { category: "bank", label: "Bank holding added" },
  "bank.holding.update": { category: "bank", label: "Bank holding edited" },
  "bank.holding.delete": { category: "bank", label: "Bank holding deleted" },
  "bank.import": { category: "bank", label: "Bank inventory synced" },
  "bank.designations.update": { category: "bank", label: "Bank slot designations changed" },
  "bank.account.update": { category: "bank", label: "Bank EQ account group changed" },
  "bank.account.delete": { category: "bank", label: "Bank EQ account group deleted" },

  // --- System --------------------------------------------------------
  "system.apikey.revoke": { category: "system", label: "API keys revoked" },
  "system.apikey.create": { category: "system", label: "API key generated" },
} as const satisfies Record<string, SystemEventDef>;

export type SystemEventAction = keyof typeof SYSTEM_EVENTS;

export function isSystemEventAction(value: string): value is SystemEventAction {
  return Object.prototype.hasOwnProperty.call(SYSTEM_EVENTS, value);
}

export function systemEventDef(action: SystemEventAction): SystemEventDef {
  return SYSTEM_EVENTS[action];
}

export const SYSTEM_EVENT_ACTIONS = Object.keys(SYSTEM_EVENTS) as SystemEventAction[];
