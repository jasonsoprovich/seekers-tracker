"use server";

import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { createAuth } from "@/auth";
import { accounts, users } from "@/db";
import { checkAndStampGuildMembership } from "@/lib/discord-verify";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export type ClaimLeaderResult = { error?: string };

// The one-time bootstrap from docs/guild-website-feasibility.md §3: "Seed
// the first-ever user as leader via a one-time bootstrap route or CLI
// script — someone has to be able to promote the rest." Self-service rather
// than a CLI script, since it can reuse the existing Discord-verified
// session instead of requiring direct D1 access.
//
// Guarded by discordVerified (only real guild members are eligible) and by
// leader count (works exactly once, guild-wide — after that, promotion only
// happens through /admin). The check-then-write has a benign race if two
// people click within the same instant during initial setup; at guild scale
// that's never actually happened for the character-name uniqueness check
// either, which is handled the same way.
export async function claimLeaderRole(): Promise<ClaimLeaderResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const [me] = await db
    .select({ role: users.role, discordVerified: users.discordVerified })
    .from(users)
    .where(eq(users.id, session.user.id));
  if (!me) return { error: "User record not found." };
  if (me.role === "leader") redirect("/admin");

  let verified = me.discordVerified;
  if (!verified) {
    // The session.create.after hook (src/auth/index.ts) re-verifies on every
    // login, so this is normally already fresh — but if
    // SEEKERS_DISCORD_GUILD_ID wasn't configured yet, or Discord's API
    // hiccuped on this exact login, discordVerified could still be stale.
    // Re-check live here instead of trusting the flag.
    // better-auth 1.7 scopes getAccessToken to a specific linked-account
    // row (accountId) rather than resolving one from providerId + userId —
    // "provider IDs cannot serve as account selectors" per the 1.7 upgrade
    // guide — so look up this user's Discord account row first.
    const [discordAccount] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.userId, session.user.id), eq(accounts.providerId, "discord")));
    if (!discordAccount) {
      return { error: "No linked Discord account found — sign in with Discord again." };
    }

    const { env, cf } = await getCloudflareContext({ async: true });
    const auth = createAuth(env, cf);
    const { accessToken } = await auth.api.getAccessToken({
      body: { accountId: discordAccount.id },
      headers: await headers(),
    });
    verified = await checkAndStampGuildMembership(db, session.user.id, accessToken);
  }
  if (!verified) {
    return { error: "You must be a verified Seekers of Souls Discord member first." };
  }

  const [existingLeader] = await db.select({ id: users.id }).from(users).where(eq(users.role, "leader"));
  if (existingLeader) {
    return { error: "The guild already has a leader — ask them to promote you from Admin." };
  }

  await db.update(users).set({ role: "leader", updatedAt: new Date() }).where(eq(users.id, session.user.id));
  redirect("/admin");
}
