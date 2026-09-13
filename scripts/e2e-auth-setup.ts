// Phase 6 task 6.7 — mints a real, valid better-auth session cookie against
// local D1 so Playwright can drive the authenticated (app) shell (the
// mobile nav drawer, Roster/Ledger cards, etc.) without Discord OAuth,
// which no environment running this suite has ever had (see every prior
// phase's "not browser-verified" note in CLAUDE.md). Never point this at
// remote D1 — local only, same as every other scripts/*.ts here.
//
// Same technique this project has used before for local-only verification
// (CLAUDE.md, Phase 0/Phase 12: "a real signed session cookie was minted
// from inside the running server's own auth context" / "cookie-builder"),
// just built on public better-auth exports (`better-auth/crypto`'s
// makeSignature) plus our own already-constructed auth instance's
// `$context`, rather than a deep, unexported import into better-auth's own
// dist/ tree.
//
// Usage: npx tsx scripts/e2e-auth-setup.ts
// Writes e2e/.auth/session.json (gitignored) in Playwright storageState
// shape. A fresh synthetic user is inserted every run (id fixed as
// "e2e-test-user") rather than depending on whatever happens to be seeded
// locally — self-contained on a clean clone, per PLAN.md's own
// local-first-testing convention.
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";
import { makeSignature } from "better-auth/crypto";

import * as schema from "../src/db";
import { characters, users } from "../src/db";
import { createAuth } from "../src/auth";

const E2E_USER_ID = "e2e-test-user";
const OUT_PATH = "e2e/.auth/session.json";
const FIXTURES_PATH = "e2e/.auth/fixtures.json";

async function main() {
  const proxy = await getPlatformProxy({ configPath: "wrangler.jsonc" });
  const db = drizzle(proxy.env.DATABASE as unknown as Parameters<typeof drizzle>[0], { schema });

  await db
    .insert(users)
    .values({
      id: E2E_USER_ID,
      email: "e2e-test-user@example.invalid",
      username: "E2E Test Leader",
      role: "leader",
      discordVerified: true,
      // Non-empty and not on the (locally blank) deny-list — see
      // isDeniedRole()/isMemberAllowed() in src/lib/discord-verify.ts.
      discordRoleIds: JSON.stringify(["000000000000000000"]),
    })
    .onConflictDoUpdate({
      target: users.id,
      set: { role: "leader", discordVerified: true, discordRoleIds: JSON.stringify(["000000000000000000"]) },
    });

  const auth = createAuth(proxy.env as unknown as CloudflareEnv, {}, "http://localhost:3000");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx: any = await auth.$context;
  const session = await ctx.internalAdapter.createSession(E2E_USER_ID);
  const signedValue = `${session.token}.${await makeSignature(session.token, ctx.secret)}`;
  const cookieName: string = ctx.authCookies.sessionToken.name;

  const storageState = {
    cookies: [
      {
        name: cookieName,
        value: signedValue,
        domain: "localhost",
        path: "/",
        expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
        httpOnly: true,
        secure: false,
        sameSite: "Lax" as const,
      },
    ],
    origins: [],
  };

  // Any real character id, so the account-page overflow check
  // (e2e/page-overflow.spec.ts) doesn't hardcode a row from one
  // developer's own local seed.
  const [anyCharacter] = await db.select({ id: characters.id }).from(characters).limit(1);

  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync("e2e/.auth", { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(storageState, null, 2));
  writeFileSync(FIXTURES_PATH, JSON.stringify({ characterId: anyCharacter?.id ?? null }, null, 2));
  console.log(`Wrote ${OUT_PATH} for user ${E2E_USER_ID}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (proxy as any).dispose?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
