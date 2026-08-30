import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { players, users } from "@/db";

// Confirms a Discord access token belongs to a member of the guild
// (SEEKERS_DISCORD_GUILD_ID) and stamps users.discordVerified accordingly.
// Shared by the account.create.after hook (src/auth/index.ts — the normal
// first-login path, run exactly once) and the on-demand re-check in
// src/app/bootstrap-leader/actions.ts (for accounts created before
// SEEKERS_DISCORD_GUILD_ID was configured, or a first-login Discord API
// hiccup, which the once-only hook can never retry on its own).
export async function checkAndStampGuildMembership(
  db: ReturnType<typeof drizzle>,
  userId: string,
  accessToken: string | null | undefined,
): Promise<boolean> {
  const guildId = process.env.SEEKERS_DISCORD_GUILD_ID;
  if (!guildId || !accessToken) return false;

  const res = await fetch("https://discord.com/api/users/@me/guilds", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return false;

  const guilds = (await res.json()) as { id: string }[];
  const isMember = guilds.some((g) => g.id === guildId);

  // Only the member endpoint (not the plain guild-list one above) carries
  // role IDs, and it 404s for non-members — only call it once membership
  // is confirmed. A failure here (rate limit, transient error) shouldn't
  // block the membership stamp, so it just leaves discordRoleIds as-is.
  let roleIds: string[] | undefined;
  if (isMember) {
    const memberRes = await fetch(`https://discord.com/api/users/@me/guilds/${guildId}/member`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (memberRes.ok) {
      const member = (await memberRes.json()) as { roles: string[] };
      roleIds = member.roles;
    }
  }

  await db
    .update(users)
    .set({
      discordVerified: isMember,
      lastLoginAt: new Date(),
      ...(roleIds ? { discordRoleIds: JSON.stringify(roleIds) } : {}),
    })
    .where(eq(users.id, userId));
  return isMember;
}

// users.discordRoleIds is the JSON.stringify'd array checkAndStampGuildMembership
// wrote above; centralized here so every reader parses it the same way.
export function parseDiscordRoleIds(discordRoleIds: string | null | undefined): string[] {
  if (!discordRoleIds) return [];
  try {
    const parsed = JSON.parse(discordRoleIds);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// PLAN.md §4b / Phase 6: site access is a deny-list, not an allow-list —
// every guild Discord member gets in except holders of "Orc Pawn"
// (applicant) or "Guest". Discord's member endpoint only returns role IDs,
// and role IDs are guild-specific (not derivable from the role names in the
// plan), so the mapping lives in SEEKERS_DISCORD_DENIED_ROLE_IDS
// (comma-separated snowflakes) rather than in code.
//
// An empty roleIds array denies too, not just a listed role. Discord's
// member endpoint deliberately omits the implicit @everyone role from this
// list — it's guild-wide, not assigned per-member — so `[]` means someone
// with literally no role assigned yet, not "no restrictions apply." Luna
// assigns roles by hand rather than on an auto-role trigger, so a brand-new
// member sits in this state for a while by design and must be denied the
// same as Orc Pawn/Guest, confirmed with the leader. This also fails
// closed if a role fetch never completed (Discord API hiccup, or a user row
// from before this column existed) — same call either way: no confirmed
// role on file, no access.
export function isDeniedRole(roleIds: string[]): boolean {
  if (roleIds.length === 0) return true;

  const raw = process.env.SEEKERS_DISCORD_DENIED_ROLE_IDS;
  if (!raw) return false;
  const denied = new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
  if (denied.size === 0) return false;
  return roleIds.some((id) => denied.has(id));
}

// The same gate `(app)/layout.tsx` applies ahead of every page — pure, so
// the layout can apply it to the one combined row it already fetches
// (username/avatarUrl/role/discordVerified/discordRoleIds + the joined
// players.status in one query) without a second D1 round-trip on every
// navigation.
//
// `playerStatus === "departed"` is a leader-initiated removal (admin
// action removeMemberFromGuild), independent of Discord: someone still in
// the Discord server but removed from the guild here is denied all the
// same. A NULL playerStatus (no players row yet — a user who hasn't logged
// in since Phase 10) is not a denial: fall through to the Discord check.
export function isMemberAllowed(
  me: { discordVerified: boolean; discordRoleIds: string | null; playerStatus?: string | null } | undefined,
): boolean {
  if (!me) return false;
  if (me.playerStatus === "departed") return false;
  return !!me.discordVerified && !isDeniedRole(parseDiscordRoleIds(me.discordRoleIds));
}

// DB-fetching wrapper for a caller with no row of its own — custom-
// worker.ts's WebSocket handler for /api/live-bids/ws (PLAN.md §15) can't
// use next/headers, so it can't go through getSession()/the layout at all,
// and has nothing pre-fetched to hand isMemberAllowed above.
export async function fetchIsMemberAllowed(db: ReturnType<typeof drizzle>, userId: string): Promise<boolean> {
  const [me] = await db
    .select({
      discordVerified: users.discordVerified,
      discordRoleIds: users.discordRoleIds,
      playerStatus: players.status,
    })
    .from(users)
    .leftJoin(players, eq(players.userId, users.id))
    .where(eq(users.id, userId));
  return isMemberAllowed(me);
}
