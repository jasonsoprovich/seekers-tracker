// REMEDIATION-PLAN-2026-09-12.md Phase 1 task 1.4 — "Cover member/officer
// removal, login after removal, explicit reinstatement, WebSocket access,
// self-removal, and last-leader protection."
//
// Phase 1 closed two real authorization gaps found in the 2026-09-12
// remediation plan's own audit of removeMemberFromGuild/isMemberAllowed:
//   1.1 removePlayerFromGuildCore (src/lib/players.ts) only ever dropped
//       users.role on removal, never players.role. syncAccountRole's
//       "higher role wins" login hook then silently restored a demoted-
//       then-removed officer/leader's old role the moment they logged back
//       in, because players.role had never moved.
//   1.2 isMemberAllowed (src/lib/discord-verify.ts) treated ANY login after
//       departedAt as proof of "rejoined Discord" and auto-restored access
//       — but lastLoginAt is stamped on every login regardless of whether
//       Discord membership genuinely lapsed and came back, so it proved
//       nothing. A departed account must now stay denied until an explicit
//       leader reinstatement.
//
// This writes real synthetic users/players/apikeys/ep_ledger rows against
// local D1 to exercise removePlayerFromGuildCore/reinstatePlayerFromGuildCore
// end to end (same pattern as verify-global-decay.ts) — snapshotted first
// and restored in a `finally` regardless of outcome, so the database is
// back to its pre-test state whether the assertions pass or fail. Never
// point this at remote D1 (PLAN.md §5) — SNAPSHOT_NAME only exists in the
// local Miniflare file snapshot.sh operates on.
//
// Usage:
//   npx tsx scripts/verify-guild-removal.ts
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import * as schema from "../src/db";
import { apikeys, characters, epLedger, players, users } from "../src/db";
import { LEADERSHIP_ROLES } from "../src/lib/authz";
import { UNKNOWN_CLASS_ID, UNKNOWN_RACE_ID } from "../src/lib/eq/enums";
import { fetchIsMemberAllowed, isMemberAllowed } from "../src/lib/discord-verify";
import { reinstatePlayerFromGuildCore, removeNonMainCharacterFromGuildCore, removePlayerFromGuildCore, syncAccountRole } from "../src/lib/players";

const SNAPSHOT_NAME = "phase1-guild-removal-test";
// Deliberately not a real Discord snowflake pattern that could collide with
// a configured deny-list entry — see the env-var override below, which
// makes this deterministic regardless of what's actually configured
// locally.
const ALLOWED_TEST_ROLE_ID = "111111111111111111";

type Db = ReturnType<typeof drizzle<typeof schema>>;

function check(failures: { n: number }, cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ok   ${msg}`);
  } else {
    console.log(`  FAIL ${msg}`);
    failures.n++;
  }
}

async function makeUser(db: Db, opts: { role: "member" | "officer" | "leader" | "admin"; discordVerified?: boolean }) {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    email: `verify-guild-removal-${id}@example.invalid`,
    discordId: `test-discord-${id}`,
    username: `VerifyUser-${id.slice(0, 8)}`,
    role: opts.role,
    discordVerified: opts.discordVerified ?? true,
    discordRoleIds: JSON.stringify([ALLOWED_TEST_ROLE_ID]),
  });
  return id;
}

async function makePlayer(db: Db, opts: { userId: string | null; role: "member" | "officer" | "leader" | "admin"; discordId?: string | null }) {
  const [row] = await db
    .insert(players)
    .values({
      userId: opts.userId,
      discordId: opts.discordId ?? (opts.userId ? `test-discord-${opts.userId}` : `test-discord-${randomUUID()}`),
      displayName: `VerifyPlayer-${randomUUID().slice(0, 8)}`,
      role: opts.role,
      status: "active",
    })
    .returning({ id: players.id });
  return row.id;
}

async function main() {
  console.log(`Saving snapshot '${SNAPSHOT_NAME}' before running a destructive test...`);
  execFileSync("scripts/snapshot.sh", ["save", SNAPSHOT_NAME], { stdio: "inherit" });

  const failures = { n: 0 };
  const proxy = await getPlatformProxy({ configPath: "wrangler.jsonc" });
  // isDeniedRole() (discord-verify.ts) reads this directly from
  // process.env — clear it for the duration of the test so the "allowed"
  // assertions below are deterministic regardless of what's actually
  // configured in this shell/.dev.vars.
  const savedDeniedRoleIds = process.env.SEEKERS_DISCORD_DENIED_ROLE_IDS;
  Reflect.deleteProperty(process.env, "SEEKERS_DISCORD_DENIED_ROLE_IDS");

  try {
    const db = drizzle(proxy.env.DATABASE as unknown as Parameters<typeof drizzle>[0], { schema });

    const [actingLeader] = await db.select({ id: users.id }).from(users).where(inArray(users.role, LEADERSHIP_ROLES)).limit(1);
    if (!actingLeader) {
      console.error("No leader/admin user in local D1 — log in once locally as the guild leader first.");
      process.exit(1);
    }

    // ---------------------------------------------------------------
    // Scenario 1: officer removal — role sync (1.1), key revocation and
    // access denial (1.3), no login-restore (1.2), reinstatement (1.4).
    // ---------------------------------------------------------------
    console.log("\nScenario 1: officer removal, login-after-removal, reinstatement");
    const officerUserId = await makeUser(db, { role: "officer" });
    const officerPlayerId = await makePlayer(db, { userId: officerUserId, role: "officer" });
    const [officerChar] = await db
      .insert(characters)
      .values({ name: `VerifyChar-${randomUUID().slice(0, 8)}`, class: UNKNOWN_CLASS_ID, race: UNKNOWN_RACE_ID, level: 1, playerId: officerPlayerId })
      .returning({ id: characters.id });
    await db.update(players).set({ mainCharacterId: officerChar.id }).where(eq(players.id, officerPlayerId));
    const [officerAlt] = await db
      .insert(characters)
      .values({
        name: `VerifyAlt-${randomUUID().slice(0, 8)}`,
        class: UNKNOWN_CLASS_ID,
        race: UNKNOWN_RACE_ID,
        level: 1,
        charType: "alt",
        mainCharacterId: officerChar.id,
        playerId: officerPlayerId,
      })
      .returning({ id: characters.id });
    const [officerMule] = await db
      .insert(characters)
      .values({ name: `VerifyMule-${randomUUID().slice(0, 8)}`, class: UNKNOWN_CLASS_ID, race: UNKNOWN_RACE_ID, level: 1, charType: "mule", playerId: officerPlayerId })
      .returning({ id: characters.id });
    // Give the character positive EP so commitDepartureWipe actually has
    // something to zero (and removalDecayEventId ends up non-null, which
    // also exercises reinstatePlayerFromGuildCore's reverseDecayEvent path).
    await db.insert(epLedger).values({
      characterId: officerChar.id,
      playerId: officerPlayerId,
      occurredAt: new Date(),
      activity: "verify-guild-removal test award",
      points: 50,
    });
    const [testKey] = await db
      .insert(apikeys)
      .values({ id: randomUUID(), referenceId: officerUserId, key: `verify-test-key-${randomUUID()}` })
      .returning({ id: apikeys.id });

    const altRemoval = await removeNonMainCharacterFromGuildCore(db, actingLeader.id, officerAlt.id);
    check(failures, !("error" in altRemoval) || !altRemoval.error, "an alt can be removed without removing its account");
    const [altAfterRemoval] = await db
      .select({ status: characters.status, removedByPlayerDeparture: characters.removedByPlayerDeparture })
      .from(characters)
      .where(eq(characters.id, officerAlt.id));
    check(failures, altAfterRemoval?.status === "removed", "individual alt removal marks only that alt removed");
    check(failures, altAfterRemoval?.removedByPlayerDeparture === false, "individual alt removal is not tagged as an account departure");
    const mainRemoval = await removeNonMainCharacterFromGuildCore(db, actingLeader.id, officerChar.id);
    check(failures, "error" in mainRemoval && /entire account/i.test(mainRemoval.error ?? ""), "a main cannot be removed while its account remains");

    const removeResult = await removePlayerFromGuildCore(db, actingLeader.id, officerPlayerId);
    check(failures, !("error" in removeResult) || !removeResult.error, `officer removal succeeds (${"error" in removeResult ? removeResult.error : "ok"})`);

    const [officerUserAfter] = await db.select({ role: users.role }).from(users).where(eq(users.id, officerUserId));
    const [officerPlayerAfter] = await db
      .select({ role: players.role, status: players.status, removalDecayEventId: players.removalDecayEventId })
      .from(players)
      .where(eq(players.id, officerPlayerId));
    check(failures, officerUserAfter?.role === "member", "task 1.1: users.role dropped to member on removal");
    check(failures, officerPlayerAfter?.role === "member", "task 1.1: players.role ALSO dropped to member on removal (the actual bug)");
    check(failures, officerPlayerAfter?.status === "departed", "players.status flipped to departed");
    check(failures, officerPlayerAfter?.removalDecayEventId != null, "EP wipe recorded a reversible decay event");
    const characterStatusesAfterAccountRemoval = await db
      .select({ id: characters.id, status: characters.status, removedByPlayerDeparture: characters.removedByPlayerDeparture })
      .from(characters)
      .where(inArray(characters.id, [officerChar.id, officerAlt.id, officerMule.id]));
    const statusByCharacter = new Map(characterStatusesAfterAccountRemoval.map((row) => [row.id, row]));
    check(failures, statusByCharacter.get(officerChar.id)?.status === "removed", "account removal removes the linked main");
    check(failures, statusByCharacter.get(officerMule.id)?.status === "removed", "account removal removes linked mules");
    check(failures, statusByCharacter.get(officerChar.id)?.removedByPlayerDeparture === true, "account removal marks the main as departure-removed");
    check(failures, statusByCharacter.get(officerMule.id)?.removedByPlayerDeparture === true, "account removal marks the mule as departure-removed");
    check(failures, statusByCharacter.get(officerAlt.id)?.removedByPlayerDeparture === false, "account removal preserves a separately removed alt's provenance");

    const remainingKeys = await db.select({ id: apikeys.id }).from(apikeys).where(eq(apikeys.id, testKey.id));
    check(failures, remainingKeys.length === 0, "task 1.3: the removed officer's app key was deleted, not just disabled");

    // Task 1.1 regression: simulate the person logging back in.
    // syncAccountRole's "higher of the two wins" rule must NOT restore the
    // pre-removal "officer" role now that BOTH columns read "member".
    await syncAccountRole(db, officerPlayerId);
    const [officerUserAfterLogin] = await db.select({ role: users.role }).from(users).where(eq(users.id, officerUserId));
    const [officerPlayerAfterLogin] = await db.select({ role: players.role }).from(players).where(eq(players.id, officerPlayerId));
    check(failures, officerUserAfterLogin?.role === "member", "task 1.1 regression: a post-removal login does not restore users.role");
    check(failures, officerPlayerAfterLogin?.role === "member", "task 1.1 regression: a post-removal login does not restore players.role");

    // Task 1.2: departed + a freshly-verified, allowed Discord login must
    // still be denied — no auto-unlock on login, ever.
    await db.update(users).set({ discordVerified: true, discordRoleIds: JSON.stringify([ALLOWED_TEST_ROLE_ID]) }).where(eq(users.id, officerUserId));
    const allowedAfterRemoval = await fetchIsMemberAllowed(db, officerUserId);
    check(failures, allowedAfterRemoval === false, "task 1.2: departed + a later verified Discord login is still denied (no auto-rejoin)");
    check(
      failures,
      isMemberAllowed({ discordVerified: true, discordRoleIds: JSON.stringify([ALLOWED_TEST_ROLE_ID]), playerStatus: "departed" }) === false,
      "task 1.2 (pure function): playerStatus departed denies regardless of discordVerified",
    );

    // Explicit reinstatement is the only way back.
    const reinstateResult = await reinstatePlayerFromGuildCore(db, actingLeader.id, officerPlayerId);
    check(failures, !("error" in reinstateResult) || !reinstateResult.error, `reinstatement succeeds (${"error" in reinstateResult ? reinstateResult.error : "ok"})`);
    const [officerPlayerReinstated] = await db
      .select({ status: players.status, departedAt: players.departedAt, removalDecayEventId: players.removalDecayEventId })
      .from(players)
      .where(eq(players.id, officerPlayerId));
    check(failures, officerPlayerReinstated?.status === "active", "reinstatement restores players.status to active");
    check(failures, officerPlayerReinstated?.departedAt === null, "reinstatement clears departedAt");
    check(failures, officerPlayerReinstated?.removalDecayEventId === null, "reinstatement clears the removalDecayEventId pointer");
    const characterStatusesAfterReinstate = await db
      .select({ id: characters.id, status: characters.status, removedByPlayerDeparture: characters.removedByPlayerDeparture })
      .from(characters)
      .where(inArray(characters.id, [officerChar.id, officerAlt.id, officerMule.id]));
    const reinstatedStatusByCharacter = new Map(characterStatusesAfterReinstate.map((row) => [row.id, row]));
    check(failures, reinstatedStatusByCharacter.get(officerChar.id)?.status === "active", "reinstatement restores the main removed with the account");
    check(failures, reinstatedStatusByCharacter.get(officerMule.id)?.status === "active", "reinstatement restores the mule removed with the account");
    check(failures, reinstatedStatusByCharacter.get(officerAlt.id)?.status === "removed", "reinstatement keeps a separately removed alt removed");
    const epAfterReinstate = await db.select({ points: epLedger.points }).from(epLedger).where(eq(epLedger.characterId, officerChar.id));
    check(failures, epAfterReinstate.reduce((sum, r) => sum + r.points, 0) === 50, "reinstatement's reverseDecayEvent restored the wiped EP");
    const allowedAfterReinstate = await fetchIsMemberAllowed(db, officerUserId);
    check(failures, allowedAfterReinstate === true, "task 1.4 (WebSocket access — fetchIsMemberAllowed): reinstated + verified Discord login is allowed again");
    // Role is deliberately NOT auto-restored — a leader re-grants it.
    const [officerUserFinal] = await db.select({ role: users.role }).from(users).where(eq(users.id, officerUserId));
    check(failures, officerUserFinal?.role === "member", "role is NOT auto-restored on reinstatement (a leader re-grants it deliberately)");

    // ---------------------------------------------------------------
    // Scenario 2: a plain member with no site login yet (players.role set
    // pre-claim, e.g. from a sheet/dump import) still gets players.role
    // reset unconditionally on removal.
    // ---------------------------------------------------------------
    console.log("\nScenario 2: removing an unlinked (no site login) officer-tier player");
    const unlinkedPlayerId = await makePlayer(db, { userId: null, role: "officer" });
    const unlinkedRemoveResult = await removePlayerFromGuildCore(db, actingLeader.id, unlinkedPlayerId);
    check(failures, !("error" in unlinkedRemoveResult) || !unlinkedRemoveResult.error, `unlinked-player removal succeeds (${"error" in unlinkedRemoveResult ? unlinkedRemoveResult.error : "ok"})`);
    const [unlinkedAfter] = await db.select({ role: players.role, status: players.status }).from(players).where(eq(players.id, unlinkedPlayerId));
    check(failures, unlinkedAfter?.role === "member", "task 1.1: players.role resets to member even with no linked users row");
    check(failures, unlinkedAfter?.status === "departed", "unlinked player is still marked departed");

    // ---------------------------------------------------------------
    // Scenario 3: self-removal is refused.
    // ---------------------------------------------------------------
    console.log("\nScenario 3: self-removal");
    const selfUserId = await makeUser(db, { role: "leader" });
    const selfPlayerId = await makePlayer(db, { userId: selfUserId, role: "leader" });
    const selfRemoveResult = await removePlayerFromGuildCore(db, selfUserId, selfPlayerId);
    check(failures, "error" in selfRemoveResult && /can't remove yourself/i.test(selfRemoveResult.error ?? ""), "self-removal is refused with a clear error");

    // ---------------------------------------------------------------
    // Scenario 4: last-leader protection. Temporarily demote every real
    // leader/admin except one synthetic leader, so removing that synthetic
    // leader would leave the guild with zero — must be refused. The whole
    // database is snapshot-restored afterward regardless, so this
    // temporary demotion never needs manual undoing.
    // ---------------------------------------------------------------
    console.log("\nScenario 4: last-leader protection");
    const soleLeaderUserId = await makeUser(db, { role: "leader" });
    const soleLeaderPlayerId = await makePlayer(db, { userId: soleLeaderUserId, role: "leader" });
    const otherLeaders = await db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(inArray(users.role, LEADERSHIP_ROLES));
    const otherLeaderIds = otherLeaders.map((r) => r.id).filter((id) => id !== soleLeaderUserId);
    if (otherLeaderIds.length > 0) {
      await db.update(users).set({ role: "officer" }).where(inArray(users.id, otherLeaderIds));
    }
    // actingLeader, not soleLeaderUserId — removePlayerFromGuildCore's
    // self-removal guard takes priority over the last-leader guard, and
    // this scenario is specifically testing the latter.
    const lastLeaderResult = await removePlayerFromGuildCore(db, actingLeader.id, soleLeaderPlayerId);
    check(
      failures,
      "error" in lastLeaderResult && /only leader\/admin/i.test(lastLeaderResult.error ?? ""),
      "removing the guild's only remaining leader/admin is refused",
    );
    // Restore immediately rather than waiting on the snapshot restore, so
    // any later scenario in this script sees the real leader roster back.
    if (otherLeaderIds.length > 0) {
      for (const row of otherLeaders) {
        if (row.id === soleLeaderUserId) continue;
        await db.update(users).set({ role: row.role }).where(eq(users.id, row.id));
      }
    }

    // ---------------------------------------------------------------
    // Scenario 5: removing an already-departed player is a no-op error,
    // not a double-wipe.
    // ---------------------------------------------------------------
    console.log("\nScenario 5: double-removal is refused");
    const doubleUserId = await makeUser(db, { role: "member" });
    const doublePlayerId = await makePlayer(db, { userId: doubleUserId, role: "member" });
    await removePlayerFromGuildCore(db, actingLeader.id, doublePlayerId);
    const doubleResult = await removePlayerFromGuildCore(db, actingLeader.id, doublePlayerId);
    check(failures, "error" in doubleResult && /already been removed/i.test(doubleResult.error ?? ""), "removing an already-departed player is refused, not re-applied");

    if (failures.n > 0) {
      console.error(`\n${failures.n} check(s) failed.`);
      process.exitCode = 1;
    } else {
      console.log("\nAll checks passed.");
    }
  } finally {
    if (savedDeniedRoleIds === undefined) Reflect.deleteProperty(process.env, "SEEKERS_DISCORD_DENIED_ROLE_IDS");
    else process.env.SEEKERS_DISCORD_DENIED_ROLE_IDS = savedDeniedRoleIds;
    await proxy.dispose();
    console.log(`Restoring snapshot '${SNAPSHOT_NAME}'...`);
    execFileSync("scripts/snapshot.sh", ["restore", SNAPSHOT_NAME], { stdio: "inherit" });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
