// REMEDIATION-PLAN-2026-09-12.md Phase 5 — "Account-Level Character
// Claims." Confirmed product decision: one officer approval claims the
// COMPLETE linked main/alt/mule player account, not just the one character
// a member happened to pick.
//
// Before this phase, approving a claim set owner_id on only the ONE claimed
// character — a returning member whose player row already owned a whole
// pre-seeded group (sheet import / derive:players, PLAN.md §11 Phase 3)
// would see "Your Characters" stay empty (it's keyed on owner_id) until
// every character in their group was individually claimed and approved one
// at a time.
//
// This exercises the fix directly against local D1, real writes (snapshot
// first, restored in a `finally` regardless of outcome — never point this
// at remote D1, PLAN.md §5):
//   5.1/5.4 — attachCharacterToPlayer's syncCharacterOwnership sets
//     owner_id for the COMPLETE resulting group, not just the character it
//     was called with, and bootstraps players.main_character_id from
//     whichever group member is typed "main."
//   5.5/5.7 — resolveOtherPendingClaimsForGroup (src/lib/claims.ts) closes
//     out every other pending claim on the same group: approved (history
//     kept, never deleted) if it was the same requester's own duplicate,
//     denied if a different requester's claim on a sibling just became
//     unfulfillable.
//   5.6 — attachCharacterToPlayer refuses outright (no partial write) when
//     the target character's current group is a real identity (has a
//     user_id or a discord_id) that isn't the claimant's own.
//   5.8 — standalone imported groups, conflicting ownership, concurrent
//     approvals across a group, denial, and a historical single-character
//     claim with no group at all.
//
// Usage:
//   npx tsx scripts/verify-character-claims.ts
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import * as schema from "../src/db";
import { characterClaims, characters, players, users } from "../src/db";
import { resolveOtherPendingClaimsForGroup } from "../src/lib/claims";
import { UNKNOWN_CLASS_ID, UNKNOWN_RACE_ID } from "../src/lib/eq/enums";
import { assignCharacterToUser, listPlayerGroupCharacters } from "../src/lib/players";
import { scriptActor } from "../src/lib/system-log";

const SNAPSHOT_NAME = "phase5-character-claims-test";

type Db = ReturnType<typeof drizzle<typeof schema>>;

function check(failures: { n: number }, cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ok   ${msg}`);
  } else {
    console.log(`  FAIL ${msg}`);
    failures.n++;
  }
}

async function makeUser(db: Db) {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    email: `verify-character-claims-${id}@example.invalid`,
    discordId: `test-discord-${id}`,
    username: `VerifyUser-${id.slice(0, 8)}`,
    role: "member",
    discordVerified: true,
  });
  return id;
}

async function makeStandalonePlayer(db: Db, opts: { discordId?: string | null; userId?: string | null } = {}) {
  const [row] = await db
    .insert(players)
    .values({
      userId: opts.userId ?? null,
      discordId: opts.discordId ?? null,
      displayName: `VerifyPlayer-${randomUUID().slice(0, 8)}`,
      role: "member",
      status: "active",
    })
    .returning({ id: players.id });
  return row.id;
}

async function makeCharacter(db: Db, opts: { playerId: number; charType: "main" | "alt" | "mule"; mainCharacterId?: number | null }) {
  const [row] = await db
    .insert(characters)
    .values({
      name: `VerifyChar-${randomUUID().slice(0, 8)}`,
      class: UNKNOWN_CLASS_ID,
      race: UNKNOWN_RACE_ID,
      level: 1,
      playerId: opts.playerId,
      charType: opts.charType,
      mainCharacterId: opts.mainCharacterId ?? null,
    })
    .returning({ id: characters.id });
  return row.id;
}

async function makeClaim(db: Db, characterId: number, requesterId: string) {
  const [row] = await db.insert(characterClaims).values({ characterId, requesterId, status: "pending" }).returning({ id: characterClaims.id });
  return row.id;
}

async function main() {
  console.log(`Saving snapshot '${SNAPSHOT_NAME}' before running a destructive test...`);
  execFileSync("scripts/snapshot.sh", ["save", SNAPSHOT_NAME], { stdio: "inherit" });

  const failures = { n: 0 };
  const proxy = await getPlatformProxy({ configPath: "wrangler.jsonc" });

  try {
    const db = drizzle(proxy.env.DATABASE as unknown as Parameters<typeof drizzle>[0], { schema });
    const actingOfficerId = await makeUser(db);

    // ---------------------------------------------------------------
    // Scenario 1: claiming an ALT of a standalone imported group claims
    // the complete main/alt/mule group, not just the alt — task 5.1/5.4.
    // ---------------------------------------------------------------
    console.log("\nScenario 1: claiming one alt claims the whole standalone group");
    const sp1 = await makeStandalonePlayer(db);
    const main1 = await makeCharacter(db, { playerId: sp1, charType: "main" });
    const alt1 = await makeCharacter(db, { playerId: sp1, charType: "alt", mainCharacterId: main1 });
    const mule1 = await makeCharacter(db, { playerId: sp1, charType: "mule" });
    const requester1 = await makeUser(db);

    const group1Before = await listPlayerGroupCharacters(db, sp1);
    check(failures, group1Before.length === 3 && group1Before[0].charType === "main", "group lists main first, then alt/mule, before any claim");

    const assigned1 = await assignCharacterToUser(db, alt1, requester1, scriptActor("verify-character-claims"));
    check(failures, assigned1.ok, `claiming the alt succeeds (${!assigned1.ok ? assigned1.error : "ok"})`);

    const groupRows1 = await db.select({ id: characters.id, ownerId: characters.ownerId }).from(characters).where(inArray(characters.id, [main1, alt1, mule1]));
    check(failures, groupRows1.every((c) => c.ownerId === requester1), "task 5.4: main, alt, AND mule all got owner_id — not just the claimed alt");

    const [requesterPlayer1] = assigned1.ok
      ? await db.select({ mainCharacterId: players.mainCharacterId }).from(players).where(eq(players.id, assigned1.playerId!))
      : [undefined];
    check(failures, requesterPlayer1?.mainCharacterId === main1, "task 5.4: claimant's player.main_character_id bootstrapped from the group's main, not the claimed alt");

    const oldStandalone1 = await db.select({ id: players.id }).from(players).where(eq(players.id, sp1));
    check(failures, oldStandalone1.length === 0, "the defunct standalone player row was absorbed away, not left stranded");

    // ---------------------------------------------------------------
    // Scenario 2: a character on a REAL identity (pre-seeded discord_id,
    // no login yet) is refused, not silently stolen — task 5.6.
    // ---------------------------------------------------------------
    console.log("\nScenario 2: refuse a silent transfer from a real (pre-seeded) identity");
    const realPlayer2 = await makeStandalonePlayer(db, { discordId: `test-discord-real-${randomUUID()}` });
    const realChar2 = await makeCharacter(db, { playerId: realPlayer2, charType: "main" });
    const requester2 = await makeUser(db);

    const assigned2 = await assignCharacterToUser(db, realChar2, requester2, scriptActor("verify-character-claims"));
    check(failures, !assigned2.ok && /linked to another member's account/i.test(assigned2.ok ? "" : assigned2.error), "task 5.6: claiming a pre-seeded real identity's character is refused");

    const [realCharAfter2] = await db.select({ ownerId: characters.ownerId, playerId: characters.playerId }).from(characters).where(eq(characters.id, realChar2));
    check(failures, realCharAfter2?.ownerId === null, "task 5.6: the refused character's owner_id was never written");
    check(failures, realCharAfter2?.playerId === realPlayer2, "task 5.6: the refused character's player_id is untouched");

    // ---------------------------------------------------------------
    // Scenario 3: two different requesters each claim a different
    // character from the SAME group — concurrent approvals. Approving one
    // must deny the other's claim on a now-unfulfillable sibling, and must
    // never grant the denied requester anything — task 5.5/5.8.
    // ---------------------------------------------------------------
    console.log("\nScenario 3: concurrent claims on siblings in the same group");
    const sp3 = await makeStandalonePlayer(db);
    const main3 = await makeCharacter(db, { playerId: sp3, charType: "main" });
    const alt3 = await makeCharacter(db, { playerId: sp3, charType: "alt", mainCharacterId: main3 });
    const requesterA3 = await makeUser(db);
    const requesterB3 = await makeUser(db);
    const claimA3 = await makeClaim(db, main3, requesterA3);
    const claimB3 = await makeClaim(db, alt3, requesterB3);

    const assigned3 = await assignCharacterToUser(db, main3, requesterA3, scriptActor("verify-character-claims"));
    check(failures, assigned3.ok, `approving requester A's claim on the main succeeds (${!assigned3.ok ? assigned3.error : "ok"})`);
    await db.update(characterClaims).set({ status: "approved", reviewedBy: actingOfficerId, reviewedAt: new Date() }).where(eq(characterClaims.id, claimA3));
    await resolveOtherPendingClaimsForGroup(db, assigned3.ok ? assigned3.playerId : null, main3, requesterA3, claimA3, actingOfficerId, new Date());

    const [claimBAfter3] = await db.select({ status: characterClaims.status, decisionNote: characterClaims.decisionNote }).from(characterClaims).where(eq(characterClaims.id, claimB3));
    check(failures, claimBAfter3?.status === "denied", "task 5.5: requester B's now-unfulfillable claim on the sibling alt was denied, not left pending");
    check(failures, /claimed by another member/i.test(claimBAfter3?.decisionNote ?? ""), "the denial carries an explanatory decision note");

    const [alt3After] = await db.select({ ownerId: characters.ownerId }).from(characters).where(eq(characters.id, alt3));
    check(failures, alt3After?.ownerId === requesterA3, "the alt went to the APPROVED requester (A), not the denied one (B)");

    const [claimBRow3] = await db.select().from(characterClaims).where(eq(characterClaims.id, claimB3));
    check(failures, claimBRow3 !== undefined, "task 5.5/5.7: the denied claim's row still exists — history is kept, never deleted");

    // ---------------------------------------------------------------
    // Scenario 4: the SAME requester has two pending claims on siblings in
    // one group (a legacy double-request) — approving one must resolve
    // the other as approved (redundant), not deny it — task 5.7.
    // ---------------------------------------------------------------
    console.log("\nScenario 4: the same requester's duplicate claims on a group consolidate as approved");
    const sp4 = await makeStandalonePlayer(db);
    const main4 = await makeCharacter(db, { playerId: sp4, charType: "main" });
    const alt4 = await makeCharacter(db, { playerId: sp4, charType: "alt", mainCharacterId: main4 });
    const requester4 = await makeUser(db);
    const claimMain4 = await makeClaim(db, main4, requester4);
    const claimAlt4 = await makeClaim(db, alt4, requester4);

    // Task 5.2's own guard (characters/claim/actions.ts's requestClaim)
    // blocks a SECOND request like this going forward; assert its query
    // shape would in fact have caught it, since this scenario constructs
    // the "already has one" state directly rather than through the
    // session-gated action.
    const group4CharacterIds = (await db.select({ id: characters.id }).from(characters).where(eq(characters.playerId, sp4))).map((c) => c.id);
    const [existingPending4] = await db
      .select({ id: characterClaims.id })
      .from(characterClaims)
      .where(inArray(characterClaims.characterId, group4CharacterIds));
    check(failures, existingPending4 !== undefined, "task 5.2: the group-wide pending-claim lookup requestClaim uses finds an existing sibling claim");

    const assigned4 = await assignCharacterToUser(db, main4, requester4, scriptActor("verify-character-claims"));
    check(failures, assigned4.ok, `approving the main's claim succeeds (${!assigned4.ok ? assigned4.error : "ok"})`);
    await db.update(characterClaims).set({ status: "approved", reviewedBy: actingOfficerId, reviewedAt: new Date() }).where(eq(characterClaims.id, claimMain4));
    await resolveOtherPendingClaimsForGroup(db, assigned4.ok ? assigned4.playerId : null, main4, requester4, claimMain4, actingOfficerId, new Date());

    const [claimAltAfter4] = await db.select({ status: characterClaims.status, decisionNote: characterClaims.decisionNote }).from(characterClaims).where(eq(characterClaims.id, claimAlt4));
    check(failures, claimAltAfter4?.status === "approved", "task 5.7: the same requester's duplicate claim on the sibling alt was auto-approved, not denied");
    check(failures, /already assigned to this member/i.test(claimAltAfter4?.decisionNote ?? ""), "the auto-approval carries an explanatory decision note");

    const group4Rows = await db.select({ ownerId: characters.ownerId }).from(characters).where(inArray(characters.id, [main4, alt4]));
    check(failures, group4Rows.every((c) => c.ownerId === requester4), "both main and alt ended up owned by the one requester");

    // ---------------------------------------------------------------
    // Scenario 5: a historical single-character claim — no group, no
    // siblings — still works exactly as before this phase.
    // ---------------------------------------------------------------
    console.log("\nScenario 5: a standalone single-character claim (no group) still works");
    const sp5 = await makeStandalonePlayer(db);
    const solo5 = await makeCharacter(db, { playerId: sp5, charType: "main" });
    const requester5 = await makeUser(db);

    const group5Before = await listPlayerGroupCharacters(db, sp5);
    check(failures, group5Before.length === 1, "a genuinely standalone character has a group of exactly one");

    const assigned5 = await assignCharacterToUser(db, solo5, requester5, scriptActor("verify-character-claims"));
    check(failures, assigned5.ok, `claiming a standalone single character succeeds (${!assigned5.ok ? assigned5.error : "ok"})`);
    const [solo5After] = await db.select({ ownerId: characters.ownerId }).from(characters).where(eq(characters.id, solo5));
    check(failures, solo5After?.ownerId === requester5, "the standalone character's owner_id was set");
    const [requesterPlayer5] = assigned5.ok
      ? await db.select({ mainCharacterId: players.mainCharacterId }).from(players).where(eq(players.id, assigned5.playerId!))
      : [undefined];
    check(failures, requesterPlayer5?.mainCharacterId === solo5, "the claimant's main pointer was bootstrapped to it");

    if (failures.n > 0) {
      console.error(`\n${failures.n} check(s) failed.`);
      process.exitCode = 1;
    } else {
      console.log("\nAll checks passed.");
    }
  } finally {
    await proxy.dispose();
    console.log(`Restoring snapshot '${SNAPSHOT_NAME}'...`);
    execFileSync("scripts/snapshot.sh", ["restore", SNAPSHOT_NAME], { stdio: "inherit" });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
