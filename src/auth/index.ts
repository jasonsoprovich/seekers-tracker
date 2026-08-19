import { betterAuth } from "better-auth";
import { withCloudflare } from "better-auth-cloudflare";
import { drizzle } from "drizzle-orm/d1";

import * as schema from "@/db";
import { checkAndStampGuildMembership } from "@/lib/discord-verify";

// Checks Discord server membership for the guild in SEEKERS_DISCORD_GUILD_ID
// and stamps users.discordVerified. Wired as an account.create.after hook
// (see below) so it runs exactly once, at first sign-in, rather than on
// every request — Discord rate-limits this endpoint. A user who signs up
// before SEEKERS_DISCORD_GUILD_ID is configured (or hits a transient
// Discord API error here) gets re-checked on demand instead — see
// src/app/bootstrap-leader/actions.ts.
async function verifyGuildMembership(
  db: ReturnType<typeof drizzle>,
  account: { userId: string; accessToken?: string | null },
) {
  await checkAndStampGuildMembership(db, account.userId, account.accessToken);
}

function createAuth(env?: CloudflareEnv, cf?: Record<string, unknown>, baseURL?: string) {
  const db = env ? drizzle(env.DATABASE, { schema }) : undefined;

  return betterAuth({
    baseURL,
    ...withCloudflare(
      {
        d1: db ? { db, options: { usePlural: true } } : undefined,
        cf: cf || {},
        // Defaults to true, which requires 8 extra columns on `sessions`
        // (timezone/city/country/...) that this app has no use for.
        geolocationTracking: false,
      },
      {
        socialProviders: {
          discord: {
            clientId: process.env.DISCORD_CLIENT_ID as string,
            clientSecret: process.env.DISCORD_CLIENT_SECRET as string,
            // better-auth appends `scope` to the provider's own defaults
            // (identify + email) unless told otherwise, so disable those and
            // request exactly what we use: "identify" for the profile,
            // "guilds" for the first-login membership check (Task 5). No
            // "email" scope, so Discord may return email: null anyway on
            // phone-only accounts — mapProfileToUser below falls back to a
            // placeholder that's never used to contact anyone.
            disableDefaultScope: true,
            scope: ["identify", "guilds"],
            mapProfileToUser: (profile: { id: string; email?: string | null }) => ({
              discordId: profile.id,
              email: profile.email ?? `${profile.id}@discord.placeholder.local`,
            }),
          },
        },
        user: {
          // Our `users` table (src/db/schema.ts) already carries these under
          // different property names; map rather than duplicate columns.
          fields: {
            name: "username",
            image: "avatarUrl",
          },
          additionalFields: {
            discordId: {
              type: "string",
              required: false,
              unique: true,
              fieldName: "discordId",
            },
            role: {
              type: ["member", "officer", "leader", "admin"],
              required: false,
              defaultValue: "member",
              // Never settable by the user themselves — promotion happens
              // through the admin panel (Phase 1 task 11).
              input: false,
              fieldName: "role",
            },
            discordVerified: {
              type: "boolean",
              required: false,
              defaultValue: false,
              // Set server-side only, after the guild-membership check.
              input: false,
              fieldName: "discordVerified",
            },
            lastLoginAt: {
              type: "date",
              required: false,
              fieldName: "lastLoginAt",
            },
          },
        },
        databaseHooks: {
          account: {
            create: {
              after: async (account) => {
                if (account.providerId !== "discord" || !db) return;
                await verifyGuildMembership(db, account);
              },
            },
          },
        },
      },
    ),
  });
}

export const auth = createAuth();
export { createAuth };
