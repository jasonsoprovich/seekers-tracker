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
// shape. Fresh synthetic member/officer/leader/admin users are inserted every
// run rather than depending on whatever happens to be seeded locally —
// self-contained on a clean clone, per PLAN.md's own
// local-first-testing convention.
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";
import { makeSignature } from "better-auth/crypto";

import * as schema from "../src/db";
import { characterClaims, characters, players, users } from "../src/db";
import { createAuth } from "../src/auth";

const E2E_USERS = [
  { id: "e2e-test-member", username: "E2E Test Member", role: "member" },
  { id: "e2e-test-officer", username: "E2E Test Officer", role: "officer" },
  { id: "e2e-test-user", username: "E2E Test Leader", role: "leader" },
  { id: "e2e-test-admin", username: "E2E Test Admin", role: "admin" },
] as const;
const OUT_PATH = "e2e/.auth";
const FIXTURES_PATH = "e2e/.auth/fixtures.json";

async function writeSession(
  auth: ReturnType<typeof createAuth>,
  userId: string,
  fileName: string,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx: any = await auth.$context;
  const session = await ctx.internalAdapter.createSession(userId);
  const signedValue = `${session.token}.${await makeSignature(session.token, ctx.secret)}`;
  const cookieName: string = ctx.authCookies.sessionToken.name;

  return {
    path: `${OUT_PATH}/${fileName}`,
    state: {
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
    },
  };
}

async function main() {
  const proxy = await getPlatformProxy({ configPath: "wrangler.jsonc" });
  const db = drizzle(proxy.env.DATABASE as unknown as Parameters<typeof drizzle>[0], { schema });

  for (const user of E2E_USERS) {
    await db
      .insert(users)
      .values({
        id: user.id,
        email: `${user.id}@example.invalid`,
        username: user.username,
        role: user.role,
        discordVerified: true,
        // Non-empty and not on the (locally blank) deny-list — see
        // isDeniedRole()/isMemberAllowed() in src/lib/discord-verify.ts.
        discordRoleIds: JSON.stringify(["000000000000000000"]),
      })
      .onConflictDoUpdate({
        target: users.id,
        set: { role: user.role, discordVerified: true, discordRoleIds: JSON.stringify(["000000000000000000"]) },
      });
  }

  const auth = createAuth(proxy.env as unknown as CloudflareEnv, {}, "http://localhost:3000");

  const leader = E2E_USERS[2];
  let [managedPlayer] = await db.select({ id: players.id }).from(players).where(eq(players.userId, leader.id));
  if (!managedPlayer) {
    await db.insert(players).values({ userId: leader.id, displayName: "E2E Managed Account", role: "leader" });
    [managedPlayer] = await db.select({ id: players.id }).from(players).where(eq(players.userId, leader.id));
  }
  if (!managedPlayer) throw new Error("Could not create the E2E managed account.");

  let [managedCharacter] = await db.select({ id: characters.id }).from(characters).where(eq(characters.name, "E2E Managed Character"));
  if (!managedCharacter) {
    await db
      .insert(characters)
      .values({ name: "E2E Managed Character", class: 1, race: 1, level: 60, charType: "main", ownerId: leader.id, playerId: managedPlayer.id });
    [managedCharacter] = await db.select({ id: characters.id }).from(characters).where(eq(characters.name, "E2E Managed Character"));
  }
  if (!managedCharacter) throw new Error("Could not create the E2E managed character.");
  await db.update(players).set({ mainCharacterId: managedCharacter.id }).where(eq(players.id, managedPlayer.id));

  let [managedMule] = await db.select({ id: characters.id }).from(characters).where(eq(characters.name, "E2E Managed Mule"));
  if (!managedMule) {
    await db.insert(characters).values({
      name: "E2E Managed Mule",
      class: 11,
      race: 12,
      level: 60,
      charType: "mule",
      ownerId: leader.id,
      playerId: managedPlayer.id,
      mainCharacterId: null,
    });
    [managedMule] = await db.select({ id: characters.id }).from(characters).where(eq(characters.name, "E2E Managed Mule"));
  } else {
    await db
      .update(characters)
      .set({ charType: "mule", ownerId: leader.id, playerId: managedPlayer.id, mainCharacterId: null, status: "active" })
      .where(eq(characters.id, managedMule.id));
  }
  if (!managedMule) throw new Error("Could not create the E2E managed mule.");

  let [departedPlayer] = await db.select({ id: players.id }).from(players).where(eq(players.displayName, "E2E Departed Account"));
  if (!departedPlayer) {
    await db.insert(players).values({ displayName: "E2E Departed Account", status: "departed", role: "member" });
    [departedPlayer] = await db.select({ id: players.id }).from(players).where(eq(players.displayName, "E2E Departed Account"));
  }
  if (!departedPlayer) throw new Error("Could not create the E2E departed account.");
  await db.update(players).set({ status: "departed", role: "member", userId: null }).where(eq(players.id, departedPlayer.id));

  let [departedCharacter] = await db.select({ id: characters.id }).from(characters).where(eq(characters.name, "E2E Departed Character"));
  if (!departedCharacter) {
    await db.insert(characters).values({
      name: "E2E Departed Character",
      class: 5,
      race: 4,
      level: 60,
      charType: "main",
      playerId: departedPlayer.id,
    });
    [departedCharacter] = await db.select({ id: characters.id }).from(characters).where(eq(characters.name, "E2E Departed Character"));
  }
  if (!departedCharacter) throw new Error("Could not create the E2E departed character.");
  await db
    .update(characters)
    .set({ ownerId: null, playerId: departedPlayer.id, charType: "main", status: "active" })
    .where(eq(characters.id, departedCharacter.id));
  await db.update(players).set({ mainCharacterId: departedCharacter.id }).where(eq(players.id, departedPlayer.id));

  // More than D1's 100-bound-parameter limit, represented as one-row
  // statements so the browser test can safely exercise the claim page's
  // group lookup on a clean local database.
  const rawDb = proxy.env.DATABASE as unknown as D1Database;
  const claimGroupNames = Array.from({ length: 101 }, (_, i) => `E2E Claim Group ${String(i + 1).padStart(3, "0")}`);
  await rawDb.batch(
    claimGroupNames.map((name) =>
      rawDb.prepare("INSERT INTO players (display_name) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM players WHERE display_name = ?)").bind(name, name),
    ),
  );
  await rawDb.batch(
    claimGroupNames.map((name) =>
      rawDb
        .prepare(
          "INSERT INTO characters (player_id, name, class, race, level, char_type) SELECT id, ?, 1, 1, 60, 'main' FROM players WHERE display_name = ? AND NOT EXISTS (SELECT 1 FROM characters WHERE name = ?) LIMIT 1",
        )
        .bind(name, name, name),
    ),
  );
  await rawDb.batch(
    claimGroupNames.map((name) =>
      rawDb
        .prepare(
          "UPDATE players SET main_character_id = (SELECT id FROM characters WHERE name = ? LIMIT 1) WHERE display_name = ?",
        )
        .bind(name, name),
    ),
  );

  const [pendingClaim] = await db
    .select({ id: characterClaims.id })
    .from(characterClaims)
    .where(and(eq(characterClaims.characterId, managedCharacter.id), eq(characterClaims.requesterId, E2E_USERS[0].id), eq(characterClaims.status, "pending")));
  if (!pendingClaim) {
    await db.insert(characterClaims).values({ characterId: managedCharacter.id, requesterId: E2E_USERS[0].id, note: "E2E workflow fixture" });
  }

  // Any real character id, so the account-page overflow check
  // (e2e/page-overflow.spec.ts) doesn't hardcode a row from one
  // developer's own local seed.
  const [anyCharacter] = await db.select({ id: characters.id }).from(characters).limit(1);

  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(OUT_PATH, { recursive: true });
  for (const user of E2E_USERS) {
    const session = await writeSession(auth, user.id, `${user.role}.json`);
    writeFileSync(session.path, JSON.stringify(session.state, null, 2));
  }
  // Keep the original path as the leader state for existing suite files.
  const leaderSession = await writeSession(auth, leader.id, "session.json");
  writeFileSync(leaderSession.path, JSON.stringify(leaderSession.state, null, 2));
  writeFileSync(
    FIXTURES_PATH,
    JSON.stringify(
      {
        characterId: anyCharacter?.id ?? null,
        managedCharacterId: managedCharacter.id,
        managedMuleId: managedMule.id,
        departedCharacterId: departedCharacter.id,
      },
      null,
      2,
    ),
  );
  console.log(`Wrote ${OUT_PATH} session states for member, officer, leader, and admin`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (proxy as any).dispose?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
