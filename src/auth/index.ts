import { betterAuth } from "better-auth";
import { withCloudflare } from "better-auth-cloudflare";
import { drizzle } from "drizzle-orm/d1";

import * as schema from "@/db";

function createAuth(env?: CloudflareEnv, cf?: Record<string, unknown>, baseURL?: string) {
  const db = env ? drizzle(env.DATABASE, { schema }) : undefined;

  return betterAuth({
    baseURL,
    ...withCloudflare(
      {
        d1: db ? { db, options: { usePlural: true } } : undefined,
        cf: cf || {},
      },
      {
        socialProviders: {
          discord: {
            clientId: process.env.DISCORD_CLIENT_ID as string,
            clientSecret: process.env.DISCORD_CLIENT_SECRET as string,
            // "identify" is default; "guilds" lets a later first-login check
            // (Phase 1 task 5) confirm server membership. No "email" scope
            // requested, so Discord may return email: null — fall back to a
            // placeholder that's never used to contact anyone.
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
              type: ["member", "officer", "leader"],
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
      },
    ),
  });
}

export const auth = createAuth();
export { createAuth };
