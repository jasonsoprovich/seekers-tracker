// Ported from pq-companion's backend/internal/popflag/resolve.go (Resolve).
// Merges the dataset with a character's stored character_pop_flags rows into
// effective per-flag status: done + provenance, computed lock state (a
// prereq is unmet), any-of group roll-up (an anchor is done once any member
// is; unchosen members are "superseded"), and per-tier/per-zone tallies.
// Pure and order-stable — Flags preserve dataset order, Zones follow
// first-seen order, Tiers are sorted ascending. See PoPFlaggingPage.tsx in
// pq-companion's frontend for the UI this feeds (§7/§9 task 10).

import { getFlags, type PoPFlag } from "./dataset";

export interface FlagState {
  flagId: string;
  done: boolean;
  source: string;
}

export interface FlagStatus extends PoPFlag {
  done: boolean;
  source?: string;
  locked: boolean;
  missing?: string[];
  superseded?: boolean;
}

export interface Progress {
  tier?: number;
  key: string;
  label: string;
  done: number;
  total: number;
  // Tier rows only: labels of this tier's key-ring steps that are still
  // outstanding (see pendingKeyrings). Display-only — never part of
  // done/total — but a tier with one left isn't shown as complete.
  pendingKeyrings?: string[];
}

export interface Resolved {
  flags: FlagStatus[];
  tiers: Progress[];
  zones: Progress[];
  done: number;
  total: number;
}

export function tierLabel(t: number): string {
  return t === 5 ? "Plane of Time" : `Tier ${t}`;
}

export interface ZoneCatalogEntry {
  zone: string;
  tier: number;
}

// The canonical, character-independent list of milestone zones (tier +
// zone, dataset order), for the PoP Progression milestone graph's column
// headers — same optional/group exclusion as resolveFlags' zone tally, so
// the header set always matches what a Resolved.zones array would contain
// for any character.
export function getZoneCatalog(): ZoneCatalogEntry[] {
  const flags = getFlags();
  const seen = new Set<string>();
  const catalog: ZoneCatalogEntry[] = [];
  for (const f of flags) {
    if (f.optional || f.group) continue;
    if (seen.has(f.zone)) continue;
    seen.add(f.zone);
    catalog.push({ zone: f.zone, tier: f.tier });
  }
  return catalog;
}

export function resolveFlags(states: FlagState[]): Resolved {
  const flags = getFlags();

  const byFlag = new Map(states.map((s) => [s.flagId, s]));

  // Any-of group roll-up: an anchor milestone is effectively done once any
  // of its members is done. Capture the satisfying member's source so the
  // anchor can show the right provenance when completed via a member.
  const groupDone = new Map<string, boolean>();
  const groupSource = new Map<string, string>();
  for (const f of flags) {
    if (f.group && byFlag.get(f.id)?.done) {
      groupDone.set(f.group, true);
      if (!groupSource.get(f.group)) {
        groupSource.set(f.group, byFlag.get(f.id)?.source ?? "");
      }
    }
  }
  const effDone = (id: string): boolean => byFlag.get(id)?.done === true || groupDone.get(id) === true;

  const out: Resolved = { flags: [], tiers: [], zones: [], done: 0, total: 0 };
  const tierIdx = new Map<number, number>();
  const zoneIdx = new Map<string, number>();

  for (const f of flags) {
    const cur = byFlag.get(f.id);
    const done = effDone(f.id);
    let source = cur?.source;
    if (!cur?.done && groupDone.get(f.id)) {
      // Anchor satisfied via a member — show the member's provenance.
      source = groupSource.get(f.id);
    }

    const fs: FlagStatus = { ...f, done, source, locked: false };

    const missing = f.prereqs.filter((p) => !effDone(p));
    if (missing.length > 0) {
      fs.locked = true;
      fs.missing = missing;
    }

    // A member of an any-of group satisfied by some OTHER member — still
    // listed, but rendered faded ("not needed").
    if (f.group && groupDone.get(f.group) && !cur?.done) {
      fs.superseded = true;
    }

    out.flags.push(fs);

    // Optional rows (keys, keyrings, bonus content) and any-of members are
    // display-only: they neither count toward the tally nor block.
    if (f.optional || f.group) continue;

    out.total++;
    if (done) out.done++;

    let ti = tierIdx.get(f.tier);
    if (ti === undefined) {
      ti = out.tiers.length;
      tierIdx.set(f.tier, ti);
      out.tiers.push({ tier: f.tier, key: tierLabel(f.tier), label: tierLabel(f.tier), done: 0, total: 0 });
    }
    out.tiers[ti].total++;
    if (done) out.tiers[ti].done++;

    let zi = zoneIdx.get(f.zone);
    if (zi === undefined) {
      zi = out.zones.length;
      zoneIdx.set(f.zone, zi);
      out.zones.push({ key: f.zone, label: f.zone, done: 0, total: 0 });
    }
    out.zones[zi].total++;
    if (done) out.zones[zi].done++;
  }

  for (const t of out.tiers) {
    t.pendingKeyrings = pendingKeyrings(out.flags, t.tier ?? 0).map((f) => f.label);
  }

  out.tiers.sort((a, b) => (a.tier ?? 0) - (b.tier ?? 0));
  return out;
}

// A tier's outstanding key-ring zone-ins (role "keyring": not done, not
// superseded). They stay out of the done/total tally, but they're the last
// step of a tier (e.g. Tower of Solusek Ro's Plane of Fire floor door), so a
// tier that collapsed as "complete" with one left hid it from the player.
// Only key-rings hold a tier open — "key" (1/raid door keys) and "optional"
// rows are genuinely optional bonus content.
export function pendingKeyrings(flags: FlagStatus[], tier: number): FlagStatus[] {
  return flags.filter((f) => f.tier === tier && f.role === "keyring" && !f.done && !f.superseded);
}

// Whether a tier reads as complete in the UI (green, collapsed by default,
// ✓): its counted steps are all done AND no key-ring step is still pending.
export function tierComplete(p: Pick<Progress, "done" | "total" | "pendingKeyrings">): boolean {
  return p.total > 0 && p.done === p.total && !p.pendingKeyrings?.length;
}

// Short header note for a tier whose tally is full but still has key-ring
// steps left, or null when there's nothing to say.
export function keyringsLeftNote(p: Pick<Progress, "done" | "total" | "pendingKeyrings">): string | null {
  const left = p.pendingKeyrings ?? [];
  if (left.length === 0 || p.total === 0 || p.done < p.total) return null;
  return left.length === 1 ? `Key-ring left: ${left[0]}` : `${left.length} key-rings left: ${left.join("; ")}`;
}

export type ZoneState = "locked" | "available" | "in_progress" | "complete";

export interface ZoneStatus {
  zone: string;
  tier: number;
  done: number;
  total: number;
  state: ZoneState;
  // Labels of the door/port keys (role "key" — one-per-raid items like the
  // Crystalline Globe or Screaming Sphere Key) this character holds in the
  // zone. Optional, so they never touch done/total or the state color — the
  // grid just overlays a key icon so officers can spot key holders.
  keys: string[];
  // Labels of the zone's key-ring zone-ins (role "keyring") still to do.
  // Out of done/total like keys, but personal: each character must zone in
  // themselves, so a zone with one left is "in_progress", never "complete".
  keyringsLeft: string[];
}

// Per-zone milestone state for a resolved character, for the Pop
// Progression milestone graph. "locked" means every non-optional flag in
// the zone is still gated on an unmet prereq; "available" means at least
// one is reachable but none is done yet.
export function zoneStatuses(resolved: Resolved): ZoneStatus[] {
  const byZone = new Map<string, { done: number; total: number; allLocked: boolean }>();
  const keysByZone = new Map<string, string[]>();
  const keyringsByZone = new Map<string, string[]>();
  for (const f of resolved.flags) {
    if (f.role === "keyring" && !f.done && !f.superseded) {
      const left = keyringsByZone.get(f.zone) ?? [];
      left.push(f.label);
      keyringsByZone.set(f.zone, left);
    }
    if (f.role === "key" && f.done) {
      const keys = keysByZone.get(f.zone) ?? [];
      keys.push(f.label);
      keysByZone.set(f.zone, keys);
    }
    if (f.optional || f.group) continue;
    const cur = byZone.get(f.zone) ?? { done: 0, total: 0, allLocked: true };
    cur.total++;
    if (f.done) cur.done++;
    if (!f.locked) cur.allLocked = false;
    byZone.set(f.zone, cur);
  }

  return getZoneCatalog().map(({ zone, tier }) => {
    const agg = byZone.get(zone) ?? { done: 0, total: 0, allLocked: true };
    const keyringsLeft = keyringsByZone.get(zone) ?? [];
    let state: ZoneState;
    if (agg.total > 0 && agg.done === agg.total) state = keyringsLeft.length > 0 ? "in_progress" : "complete";
    else if (agg.done > 0) state = "in_progress";
    else if (agg.total > 0 && agg.allLocked) state = "locked";
    else state = "available";
    return { zone, tier, done: agg.done, total: agg.total, state, keys: keysByZone.get(zone) ?? [], keyringsLeft };
  });
}
