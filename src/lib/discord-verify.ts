import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { users } from "@/db";

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
