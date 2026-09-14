// Phase 11.4: exercise Better Auth 1.7.4 against local D1 only. This verifies
// account identity after the temporary issuer field is removed without making
// a real Discord request or touching production.
import assert from "node:assert/strict";

import { makeSignature } from "better-auth/crypto";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import { createAuth } from "../src/auth";
import * as schema from "../src/db";
import { accounts, apikeys, players, sessions, users } from "../src/db";

const USER_EMAIL = "phase11-auth-user@example.invalid";
const DISCORD_ACCOUNT_ID = "phase11-discord-subject";
const LINKED_ACCOUNT_ID = "phase11-linked-subject";
const LINKED_PROVIDER_ID = "phase11-linked-provider";

function cookieHeader(setCookies: string[]): string {
  return setCookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

async function cleanupTestUser(db: ReturnType<typeof drizzle<typeof schema>>, userId: string) {
  await db.delete(apikeys).where(eq(apikeys.referenceId, userId));
  await db.delete(players).where(eq(players.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

async function main() {
  const proxy = await getPlatformProxy({ configPath: "wrangler.jsonc" });
  const db = drizzle(proxy.env.DATABASE as unknown as Parameters<typeof drizzle>[0], { schema });
  let checks = 0;
  let userId: string | undefined;

  try {
    const staleUsers = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL));
    for (const staleUser of staleUsers) await cleanupTestUser(db, staleUser.id);

    const auth = createAuth(proxy.env as unknown as CloudflareEnv, {}, "http://localhost:3000");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx: any = await auth.$context;
    checks++;

    const accountColumns = await db.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('accounts')`);
    const accountIndexes = await db.all<{ name: string }>(sql`SELECT name FROM pragma_index_list('accounts')`);
    assert(!accountColumns.some((column) => column.name === "issuer"), "accounts.issuer still exists");
    assert(
      !accountIndexes.some((index) => index.name === "accounts_issuer_account_id_idx"),
      "issuer compound index still exists",
    );
    checks += 2;

    const created = await ctx.internalAdapter.createOAuthUser(
      {
        name: "Phase 11 Auth User",
        email: USER_EMAIL,
        emailVerified: true,
        image: null,
        discordId: "phase11-discord-id",
        role: "officer",
        discordVerified: true,
        discordRoleIds: JSON.stringify(["phase11-member-role"]),
      },
      {
        providerId: "discord",
        accountId: DISCORD_ACCOUNT_ID,
        accessToken: "phase11-access-token",
        scope: "identify,guilds,guilds.members.read",
      },
    );
    assert.equal(created.user.id.length > 0, true, "first-time OAuth user was not created");
    userId = created.user.id;
    checks++;

    const existing = await ctx.internalAdapter.findAccountOwnerByKey({
      providerId: "discord",
      accountId: DISCORD_ACCOUNT_ID,
    });
    assert.equal(existing?.kind, "owned", "existing Discord account was not found by provider/account key");
    assert.equal(existing?.user.id, userId, "existing Discord account resolved to the wrong user");
    checks += 2;

    await ctx.internalAdapter.linkAccount({
      userId,
      providerId: LINKED_PROVIDER_ID,
      accountId: LINKED_ACCOUNT_ID,
    });
    const linkedAccounts = await ctx.internalAdapter.findAccounts(userId);
    assert.equal(linkedAccounts.length, 2, "linked account was not attached to the existing user");
    assert(
      linkedAccounts.some(
        (account: { providerId: string; accountId: string }) =>
          account.providerId === LINKED_PROVIDER_ID && account.accountId === LINKED_ACCOUNT_ID,
      ),
      "linked account cannot be resolved by its stable provider/account key",
    );
    checks += 2;

    const session = await ctx.internalAdapter.createSession(userId);
    const signedToken = `${session.token}.${await makeSignature(session.token, ctx.secret)}`;
    const sessionCookie = `${ctx.authCookies.sessionToken.name}=${signedToken}`;
    const sessionResponse = await auth.handler(
      new Request("http://localhost:3000/api/auth/get-session", {
        headers: { cookie: sessionCookie },
      }),
    );
    assert.equal(sessionResponse.status, 200, "session read failed");
    const sessionBody = (await sessionResponse.json()) as { user?: { id?: string } } | null;
    assert.equal(sessionBody?.user?.id, userId, "session resolved to the wrong user");
    const cacheCookies = sessionResponse.headers.getSetCookie();
    assert(
      cacheCookies.some((cookie) => cookie.includes("session_data")),
      "session read did not issue the configured cookie cache",
    );
    checks += 3;

    const createdKey = await auth.api.createApiKey({
      body: {
        name: "Phase 11 verification",
        userId,
        permissions: { epgp: ["write"] },
      },
    });
    const verifiedKey = await auth.api.verifyApiKey({
      body: { key: createdKey.key, permissions: { epgp: ["write"] } },
    });
    assert.equal(verifiedKey.valid, true, "new API key did not verify");
    const listedKeys = await auth.api.listApiKeys({ headers: new Headers({ cookie: sessionCookie }) });
    const listedKey = listedKeys.apiKeys.find((key) => key.name === "Phase 11 verification");
    assert(listedKey, "new API key was not listed for its owner");
    await auth.api.deleteApiKey({
      body: { keyId: listedKey.id },
      headers: new Headers({ cookie: sessionCookie }),
    });
    const deletedKey = await auth.api.verifyApiKey({ body: { key: createdKey.key } });
    assert.equal(deletedKey.valid, false, "deleted API key still verifies");
    checks += 4;

    await ctx.internalAdapter.deleteSession(session.token);
    const cachedSessionResponse = await auth.handler(
      new Request("http://localhost:3000/api/auth/get-session", {
        headers: { cookie: cookieHeader([sessionCookie, ...cacheCookies]) },
      }),
    );
    const cachedSessionBody = (await cachedSessionResponse.json()) as { user?: { id?: string } } | null;
    assert.equal(cachedSessionBody?.user?.id, userId, "cookie cache did not preserve the signed session identity");
    checks++;

    const logoutSession = await ctx.internalAdapter.createSession(userId);
    const signedLogoutToken = `${logoutSession.token}.${await makeSignature(logoutSession.token, ctx.secret)}`;
    const logoutCookie = `${ctx.authCookies.sessionToken.name}=${signedLogoutToken}`;
    const signOutResponse = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-out", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: logoutCookie,
          origin: "http://localhost:3000",
        },
        body: "{}",
      }),
    );
    assert.equal(signOutResponse.status, 200, "logout failed");
    const deletedSession = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.token, logoutSession.token));
    assert.equal(deletedSession.length, 0, "logout did not delete the database session");
    assert(
      signOutResponse.headers.getSetCookie().some((cookie) => cookie.includes(`${ctx.authCookies.sessionToken.name}=`)),
      "logout did not clear the session cookie",
    );
    checks += 3;

    const duplicateKeys = await db
      .select({ count: sql<number>`count(*)` })
      .from(accounts)
      .where(
        and(
          eq(accounts.providerId, "discord"),
          eq(accounts.accountId, DISCORD_ACCOUNT_ID),
        ),
      );
    assert.equal(Number(duplicateKeys[0]?.count ?? 0), 1, "Discord identity was duplicated");
    checks++;

    console.log(`Phase 11 auth upgrade verification: ${checks}/${checks} checks passed`);
  } finally {
    if (userId) await cleanupTestUser(db, userId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (proxy as any).dispose?.();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
