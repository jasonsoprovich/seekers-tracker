import { apiKey } from "@better-auth/api-key";
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
        // Officer-issued keys for the standalone EPGP parser app
        // (seekers-epgp-parser) to call /api/officer/* without a browser
        // session. Deliberately NOT using `enableSessionForAPIKeys` — that
        // option mocks a full site session for any request carrying a valid
        // key, meaning a leaked key could act as that officer everywhere on
        // the site (every page, every server action), not just the two
        // narrow officer routes it's meant for. Instead, those routes call
        // `auth.api.verifyApiKey` directly and check the required
        // permission themselves — see src/lib/api-key-auth.ts.
        plugins: [
          apiKey({
            requireName: true,
            // @better-auth/api-key's defaultExpiresIn is SECONDS (see its
            // own expiresIn zod schema — "Expiration time ... in seconds"
            // — and getDate(opts.keyExpiration.defaultExpiresIn, "sec") in
            // the plugin source), not milliseconds. The previous value
            // here (1000 * 60 * 60 * 24 * 180) was 180 days worth of
            // *milliseconds* fed in as seconds — ~493 years, i.e. keys
            // that never meaningfully expire. 180 real days:
            keyExpiration: { defaultExpiresIn: 60 * 60 * 24 * 180 },
            // @better-auth/api-key's rate-limit default is 10 requests per
            // 24-hour window (its own resolveConfiguration default,
            // undocumented in this app's config since we never set
            // `rateLimit` before). A denied request comes back from
            // verifyApiKey as `{valid: false}` indistinguishable from a
            // truly invalid/expired key by requireOfficerApiKey, which is
            // what looked like "the key stops working" — the parser app's
            // Browse tab and roster lookups alone burn through 10 requests
            // in minutes. Raised to a window officers won't realistically
            // hit while clicking around.
            rateLimit: { enabled: true, timeWindow: 60 * 1000, maxRequests: 120 },
          }),
        ],
      },
    ),
  });
}

export const auth = createAuth();
export { createAuth };
