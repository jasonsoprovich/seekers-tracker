import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { withCloudflare } from "better-auth-cloudflare";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import * as schema from "@/db";
import { checkAndStampGuildMembership } from "@/lib/discord-verify";
import { resolvePlayerForUser } from "@/lib/players";

// Checks Discord server membership + roles for the guild in
// SEEKERS_DISCORD_GUILD_ID and stamps users.discordVerified/discordRoleIds.
// Wired as a session.create.after hook (see below) — a session is created
// on every sign-in (first-ever and every return visit alike), which is what
// Phase 6 task 6.3 means by "re-verify on login": a Discord role change
// (e.g. promoted out of Guest) should take effect next login, not require
// unlinking Discord. Runs once per login, not per request — Discord
// rate-limits this endpoint. A user who signs up before
// SEEKERS_DISCORD_GUILD_ID is configured (or hits a transient Discord API
// error here) gets re-checked on demand too — see
// src/app/(app)/bootstrap-leader/actions.ts.
async function verifyGuildMembershipOnLogin(db: ReturnType<typeof drizzle>, userId: string) {
  // The account's accessToken, not passed to this hook directly (unlike the
  // old account.create.after hook this replaced) — read the row instead.
  // This app doesn't configure better-auth's optional OAuth-token
  // encryption, so the stored value is the same plaintext token
  // auth.api.getAccessToken would return; revisit this read if that ever
  // changes. Fresh as of this exact login: better-auth updates an existing
  // account's tokens before creating the new session, same request.
  const [discordAccount] = await db
    .select({ accessToken: schema.accounts.accessToken })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.userId, userId), eq(schema.accounts.providerId, "discord")));
  if (!discordAccount) return;
  await checkAndStampGuildMembership(db, userId, discordAccount.accessToken);
}

// PLAN.md §11 Phase 10 task 10.1 — "a user logging in via Discord resolves
// to a players row by discord_id ... rather than claiming characters one
// at a time from scratch." Runs alongside the guild-membership check,
// same session.create.after hook, same reasoning (idempotent, cheap,
// re-run every login rather than gated behind a one-time signup event).
async function resolvePlayerOnLogin(db: ReturnType<typeof drizzle>, userId: string) {
  const [user] = await db
    .select({ id: schema.users.id, discordId: schema.users.discordId, username: schema.users.username })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!user) return;
  await resolvePlayerForUser(db, user);
}

function buildAuth(env?: CloudflareEnv, cf?: Record<string, unknown>, baseURL?: string) {
  const db = env ? drizzle(env.DATABASE, { schema }) : undefined;

  return betterAuth({
    baseURL,
    // Origins allowed to POST to the auth handler and to be used as an
    // OAuth callback origin. In production the app is served only from
    // seekersofsouls.com (www + the old seekers.fetchinglogic.com host
    // 301/308 to it in custom-worker.ts), but a stale bookmark can still
    // land a sign-in POST on one of those hosts before the redirect, and
    // BETTER_AUTH_URL pins the Discord redirect_uri to the canonical host
    // regardless. localhost covers `npm run preview` / `next dev`.
    trustedOrigins: [
      "https://seekersofsouls.com",
      "https://www.seekersofsouls.com",
      "https://seekers.fetchinglogic.com",
      "http://localhost:8787",
      "http://localhost:3000",
    ],
    ...withCloudflare(
      {
        d1: db ? { db, options: { usePlural: true } } : undefined,
        cf: cf || {},
        // Defaults to true, which requires 8 extra columns on `sessions`
        // (timezone/city/country/...) that this app has no use for.
        geolocationTracking: false,
      },
      {
        // Cache the session identity in a short-lived signed cookie so a
        // normal page load doesn't hit D1 just to answer "is this a valid
        // session, and whose". Added 2026-09-07 after officers got bounced
        // to /login during the two deploys that day — a cold Worker isolate
        // plus a slow first D1 query was enough for getSession() to come
        // back empty and redirect. This makes the common case stateless.
        // Safe here because the things that MUST stay fresh are read
        // straight from D1 regardless of this cache: role via getUserRole
        // (authz.ts explicitly re-reads users.role every request), and the
        // guild-membership / denied-role / departed-player gate via its own
        // query in (app)/layout.tsx. The only cost — a revoked session
        // lingering up to maxAge — doesn't apply: nothing in this app
        // revokes a session out from under a device (sign-out clears the
        // cookie on that device itself).
        session: {
          cookieCache: { enabled: true, maxAge: 5 * 60 },
        },
        socialProviders: {
          discord: {
            clientId: process.env.DISCORD_CLIENT_ID as string,
            clientSecret: process.env.DISCORD_CLIENT_SECRET as string,
            // better-auth's Discord provider defaults `prompt` to "none"
            // (see @better-auth/core's discord.ts: `prompt: options.prompt
            // || "none"`), i.e. "authorise silently, never show me any UI".
            // Discord only completes that when the browser already has a
            // live Discord session AND a prior authorisation for this exact
            // client + scope set; otherwise it bounces straight back to the
            // callback with `?error=consent_required`, better-auth lands on
            // /api/auth/error, no session is created, and the user is stuck
            // in a "click Sign in, get thrown back, click again" loop —
            // which is what a tab left open overnight (Discord session or
            // app authorisation lapsed) hits every time. "consent" makes
            // Discord actually render its authorise screen when it can't
            // proceed silently, so a lapsed user gets a real button instead
            // of a dead end. Cost: one extra "Authorise" click per login.
            // "none" | "consent" are the only values this provider accepts.
            prompt: "consent",
            // better-auth appends `scope` to the provider's own defaults
            // (identify + email) unless told otherwise, so disable those and
            // request exactly what we use: "identify" for the profile,
            // "guilds" for the first-login membership check (Task 5),
            // "guilds.members.read" so that same check can also fetch the
            // user's role IDs within the guild (GET
            // /users/@me/guilds/{guild.id}/member) — see
            // src/lib/discord-verify.ts. No "email" scope, so Discord may
            // return email: null anyway on phone-only accounts —
            // mapProfileToUser below falls back to a placeholder that's
            // never used to contact anyone.
            disableDefaultScope: true,
            scope: ["identify", "guilds", "guilds.members.read"],
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
            discordRoleIds: {
              type: "string",
              required: false,
              // Set server-side only, alongside discordVerified.
              input: false,
              fieldName: "discordRoleIds",
            },
            lastLoginAt: {
              type: "date",
              required: false,
              fieldName: "lastLoginAt",
            },
          },
        },
        databaseHooks: {
          session: {
            create: {
              // "after", not "before": never block a login on Discord's API
              // being slow/down. A stale discordVerified/discordRoleIds
              // just falls back to last-known-good until the next login,
              // same as before this hook existed at all.
              after: async (session) => {
                if (!db) return;
                await verifyGuildMembershipOnLogin(db, session.userId);
                await resolvePlayerOnLogin(db, session.userId);
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

// The RSC session-read path (src/lib/session.ts getSession) calls
// createAuth on every request with no baseURL. Rebuilding the whole
// better-auth instance — plugins, the drizzle adapter, the api-key plugin —
// each time measured ~10-20ms of the getSession cost (post-live-test-1
// LT-26 #4). The instance only depends on `env`, stable for the life of an
// isolate; `cf` feeds geolocation / IP detection, both used only at session
// *creation* (login), which goes through the API route with an explicit
// baseURL and so never reads this cache.
let cachedAuth: ReturnType<typeof buildAuth> | undefined;
let cachedAuthEnv: CloudflareEnv | undefined;

function createAuth(env?: CloudflareEnv, cf?: Record<string, unknown>, baseURL?: string) {
  if (!baseURL && env && cachedAuth && cachedAuthEnv === env) return cachedAuth;
  const built = buildAuth(env, cf, baseURL);
  if (!baseURL && env) {
    cachedAuth = built;
    cachedAuthEnv = env;
  }
  return built;
}

export const auth = createAuth();
export { createAuth };
