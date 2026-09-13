import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import * as schema from "@/db";
import { characters, epLedger, gpLedger, mainSwapEvents, playerEpgpTotals, players, users } from "@/db";
import { revokeApiKeysForUser } from "@/lib/api-key-auth";
import { LEADERSHIP_ROLES, roleRank, type Role } from "@/lib/authz";
import { commitDepartureWipe, reverseDecayEvent } from "@/lib/epgp/decay";
import { recordLedgerChange } from "@/lib/epgp/ledger-audit";
import { refreshStandings } from "@/lib/epgp/standings";

// PLAN.md §11 Phase 10 — character claiming rework, built on the `players`
// table Phase 3 introduced. Four entry points:
//   resolvePlayerForUser  — task 10.1, called on every login
//   attachCharacterToPlayer — task 10.2, called from claim approval and
//     from new-character creation (also closes the PLAN.md §16 gap: a
//     site-created character never got player_id set)
//   swapMainCharacter     — task 10.3, leader/admin-only; post-live-test-1
//     LT-30 added a waivable 500 GP fee + reverseMainSwap
//   createStandalonePlayer — same job as attachCharacterToPlayer, for a
//     character that has no player at all yet (discord_id-less, same
//     "sheet-only" shape PLAN.md §11 Phase 3 task 3.5 already established)

// Schema-typed (not the bare `ReturnType<typeof drizzle>` most of this
// codebase's lib functions use) — removePlayerFromGuildCore below passes
// its db straight into revokeApiKeysForUser, which requires the
// schema-carrying type. Every real caller already hands in getDb()'s
// result, which satisfies this.
type Db = ReturnType<typeof drizzle<typeof schema>>;

// post-live-test-1 LT-30: swapping which character is a player's main costs
// the new main 500 GP, charged as a normal manual gp_ledger row. A leader
// can waive it on the confirm dialog (fee 0, no row). reverseMainSwap
// refunds exactly what was charged.
export const MAIN_SWAP_FEE_GP = 500;

// Resolves the given (already Discord-authenticated) user to their
// `players` row, creating the link — or the row itself — if neither exists
// yet. Idempotent; safe to call on every login.
//
// Three cases, in order:
//  1. A players row already has user_id = this user — nothing to do.
//  2. Toryn's dump (or the sheet-only derivation, PLAN.md §11 Phase 3 tasks
//     3.4/3.5) already seeded a players row for this discord_id, but no
//     site account has ever claimed it (user_id NULL) — link it now. This
//     is the common case for anyone who's been in the guild a while.
//  3. No players row exists for this discord_id at all (a member who
//     joined after the dump, or whose discord_id somehow never made it in)
//     — create one. Every logged-in user needs a players row to eventually
//     attach characters to; there's nothing to "claim" for a brand-new
//     member.
export async function resolvePlayerForUser(
  db: Db,
  user: { id: string; discordId: string | null; username: string | null },
): Promise<number | null> {
  if (!user.discordId) return null; // Non-Discord accounts don't exist in this app; defensive only.

  const [linked] = await db.select({ id: players.id }).from(players).where(eq(players.userId, user.id));
  if (linked) {
    await syncAccountRole(db, linked.id);
    return linked.id;
  }

  const [seeded] = await db
    .select({ id: players.id })
    .from(players)
    .where(and(eq(players.discordId, user.discordId), isNull(players.userId)));
  if (seeded) {
    await db.update(players).set({ userId: user.id, updatedAt: new Date() }).where(eq(players.id, seeded.id));
    await syncAccountRole(db, seeded.id);
    return seeded.id;
  }

  const [created] = await db
    .insert(players)
    .values({
      discordId: user.discordId,
      userId: user.id,
      displayName: user.username ?? user.discordId,
      status: "active",
      joinedAt: new Date(),
    })
    .returning({ id: players.id });
  return created.id;
}

// Keep players.role (the account's guild role, what the roster shows) and
// users.role (site permissions) equal for an account that has a login. On
// first meeting — a member signing in to an account a leader already
// marked officer, or a leader promoting a login whose account row still
// says member — the HIGHER of the two wins, so a pre-claim assignment is
// honoured and a live promotion is never undone. Idempotent; called on
// every login and after every role change.
export async function syncAccountRole(db: Db, playerId: number): Promise<void> {
  const [row] = await db
    .select({ playerRole: players.role, userId: players.userId, userRole: users.role })
    .from(players)
    .leftJoin(users, eq(users.id, players.userId))
    .where(eq(players.id, playerId));
  if (!row || row.userId === null || row.userRole === null) return;
  const target: Role = roleRank(row.playerRole as Role) >= roleRank(row.userRole as Role) ? (row.playerRole as Role) : (row.userRole as Role);
  const now = new Date();
  if (row.playerRole !== target) await db.update(players).set({ role: target, updatedAt: now }).where(eq(players.id, playerId));
  if (row.userRole !== target) await db.update(users).set({ role: target, updatedAt: now }).where(eq(users.id, row.userId));
}

// A character being attached to a player can already sit on a *different*
// player. If that old player is a pure import artefact — no site user, no
// discord_id: a standalone created by derive:players / the sheet import /
// createStandalonePlayer — it's the same real person, so absorb it
// wholesale: its characters AND its ledger history move to the target, and
// the defunct row is deleted. Without this, claiming a character that has
// EP history strands that history on the old player_id and the roster
// zeroes out (found 2026-09-06 — the first real claim on production, Osui,
// did exactly this).
//
// If the old player has a user_id or a discord_id it's a real account —
// never merged silently here (a genuine character transfer between two
// people is a leader decision, not a side effect of a claim).
async function absorbStandalonePlayer(db: Db, fromPlayerId: number, toPlayerId: number): Promise<boolean> {
  if (fromPlayerId === toPlayerId) return false;
  const [from] = await db
    .select({ userId: players.userId, discordId: players.discordId })
    .from(players)
    .where(eq(players.id, fromPlayerId));
  if (!from || from.userId !== null || from.discordId !== null) return false;

  const now = new Date();
  await db.update(characters).set({ playerId: toPlayerId, updatedAt: now }).where(eq(characters.playerId, fromPlayerId));
  await db.update(epLedger).set({ playerId: toPlayerId }).where(eq(epLedger.playerId, fromPlayerId));
  await db.update(gpLedger).set({ playerId: toPlayerId }).where(eq(gpLedger.playerId, fromPlayerId));
  await db.delete(playerEpgpTotals).where(eq(playerEpgpTotals.playerId, fromPlayerId));
  await db.delete(players).where(eq(players.id, fromPlayerId));
  return true;
}

export type AttachResult = { error?: string };

// Links a character to a player (PLAN.md §10 "claiming an unassigned
// character attaches it to their player, with type main/alt/mule" — the
// type itself is whatever the character's own char_type already carries
// from import/creation, not re-asked here). If the player doesn't have a
// main yet and this character already is one, bootstrap
// players.main_character_id — the common case of a member's very first
// claimed/created character. A player who already has a main is left
// alone here even if the newly attached character is also charType
// "main" (a genuine conflict, e.g. Toryn's dump had a couple of these,
// PLAN.md §11 Phase 3 task 3.4) — that needs a human decision
// (swapMainCharacter), not a guess.
export async function attachCharacterToPlayer(db: Db, characterId: number, playerId: number): Promise<AttachResult> {
  const [character] = await db
    .select({ id: characters.id, charType: characters.charType, playerId: characters.playerId })
    .from(characters)
    .where(eq(characters.id, characterId));
  if (!character) return { error: "Character not found." };

  // Character already belongs to a defunct standalone player — pull that
  // player's characters + ledger history across before repointing.
  if (character.playerId !== null && character.playerId !== playerId) {
    await absorbStandalonePlayer(db, character.playerId, playerId);
  }

  await db.update(characters).set({ playerId, updatedAt: new Date() }).where(eq(characters.id, characterId));

  if (character.charType === "main") {
    const [player] = await db.select({ mainCharacterId: players.mainCharacterId }).from(players).where(eq(players.id, playerId));
    if (player && player.mainCharacterId === null) {
      await db.update(players).set({ mainCharacterId: characterId, updatedAt: new Date() }).where(eq(players.id, playerId));
    }
  }

  return {};
}

export type AssignResult = { ok: true; playerId: number | null } | { ok: false; error: string };

// The core of "this character now belongs to this account" — shared by
// claim approval (admin/claims/actions.ts) and the officer/leader "assign a
// character to a member" action (admin/actions.ts). Re-checks the character
// is still unclaimed (a benign check-then-write race if two assignments
// land together, same as acknowledged elsewhere), sets owner_id, resolves
// the user's players row and attaches the character to it — which also
// pulls any stranded ledger history under the one identity (see
// attachCharacterToPlayer / absorbStandalonePlayer). The caller does the
// follow-up refreshStandings({ playerIds: [result.playerId] }); kept out of
// here so this module doesn't take a dependency on the standings layer.
export async function assignCharacterToUser(db: Db, characterId: number, userId: string): Promise<AssignResult> {
  const [character] = await db.select({ ownerId: characters.ownerId }).from(characters).where(eq(characters.id, characterId));
  if (!character) return { ok: false, error: "That character no longer exists." };
  if (character.ownerId !== null) return { ok: false, error: "That character has already been claimed by someone else." };

  await db.update(characters).set({ ownerId: userId, updatedAt: new Date() }).where(eq(characters.id, characterId));

  const [user] = await db
    .select({ id: users.id, discordId: users.discordId, username: users.username })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) return { ok: true, playerId: null };

  const playerId = await resolvePlayerForUser(db, user);
  if (playerId) await attachCharacterToPlayer(db, characterId, playerId);
  return { ok: true, playerId: playerId ?? null };
}

export type SwapMainResult = { error?: string };

// PLAN.md §11 Phase 10 task 10.3 — "leader-approved main swap = update
// players.main_character_id, EP/GP untouched." EP/GP standings are untouched
// by construction: computeEpgpTotals groups by ep_ledger/gp_ledger.player_id
// (Phase 3 task 3.11), which the re-typing never writes to — only
// players.main_character_id and, to keep the roster's display grouping
// correct (§4c: "char_type is display metadata kept in sync"), the
// affected characters' char_type/main_character_id.
//
// post-live-test-1 LT-30 additions:
//  - `feeGp` (0 = waived, else MAIN_SWAP_FEE_GP) is charged to the NEW main
//    as an ordinary manual gp_ledger row. GP already follows the account
//    (ledger.player_id), so "EP/GP stays with the account, moves old main →
//    new main" needs no work here — the fee is the only new number.
//  - a main_swap_events row records the pre-swap state so reverseMainSwap
//    can undo both the re-typing and the fee, any time later.
//
// Caller (src/app/(app)/admin/actions.ts) is responsible for the
// canManageRoles gate — this function only enforces that the target
// character actually belongs to the given player.
export async function swapMainCharacter(
  db: Db,
  playerId: number,
  newMainCharacterId: number,
  approvedBy: string,
  feeGp: number,
): Promise<SwapMainResult> {
  const [target] = await db
    .select({ id: characters.id, name: characters.name, playerId: characters.playerId, charType: characters.charType })
    .from(characters)
    .where(eq(characters.id, newMainCharacterId));
  if (!target) return { error: "Character not found." };
  if (target.playerId !== playerId) return { error: "That character doesn't belong to this player." };
  if (target.charType === "mule") return { error: "A mule can't be a player's main character." };

  const [player] = await db.select({ mainCharacterId: players.mainCharacterId }).from(players).where(eq(players.id, playerId));
  if (!player) return { error: "Player not found." };
  if (player.mainCharacterId === newMainCharacterId) return { error: "That character is already this player's main." };

  const now = new Date();

  // Snapshot every non-mule character of this player BEFORE re-typing —
  // the exact set the two UPDATEs below touch — so reverseMainSwap can put
  // the grouping back verbatim.
  const affected = await db
    .select({ id: characters.id, charType: characters.charType, mainCharacterId: characters.mainCharacterId })
    .from(characters)
    .where(and(eq(characters.playerId, playerId), ne(characters.charType, "mule")));

  const prevMainCharacterId = player.mainCharacterId;
  const prevMainName = prevMainCharacterId
    ? (await db.select({ name: characters.name }).from(characters).where(eq(characters.id, prevMainCharacterId)))[0]?.name ?? null
    : null;

  // Every other non-mule character this player owns becomes an alt of the
  // new main; mules are left untouched (they're never grouped under a
  // main in the roster display regardless — RosterTable only nests
  // charType "alt" rows, PLAN.md §4c).
  await db
    .update(characters)
    .set({ charType: "alt", mainCharacterId: newMainCharacterId, updatedAt: now })
    .where(and(eq(characters.playerId, playerId), ne(characters.id, newMainCharacterId), ne(characters.charType, "mule")));

  await db
    .update(characters)
    .set({ charType: "main", mainCharacterId: null, updatedAt: now })
    .where(eq(characters.id, newMainCharacterId));

  await db
    .update(players)
    .set({ mainCharacterId: newMainCharacterId, mainCharacterChangedBy: approvedBy, mainCharacterChangedAt: now, updatedAt: now })
    .where(eq(players.id, playerId));

  // The fee — a plain manual GP charge on the new main, audited like any
  // other manual ledger write. Skipped entirely when waived.
  let feeGpLedgerId: number | null = null;
  if (feeGp > 0) {
    const noteText = `Main swap fee — ${prevMainName ?? "(no previous main)"} → ${target.name}`;
    const [feeRow] = await db
      .insert(gpLedger)
      .values({
        characterId: newMainCharacterId,
        playerId,
        occurredAt: now,
        itemName: null,
        tier: "Main Swap Fee",
        points: feeGp,
        pointsNominal: feeGp,
        pointsAwarded: feeGp,
        capApplied: false,
        capAtEntry: null,
        note: noteText,
        enteredBy: approvedBy,
        source: "manual",
      })
      .returning();
    feeGpLedgerId = feeRow.id;
    await recordLedgerChange(db, "gp", feeRow.id, "create", null, feeRow, approvedBy);
  }

  await db.insert(mainSwapEvents).values({
    playerId,
    prevMainCharacterId,
    newMainCharacterId,
    feeGp,
    feeGpLedgerId,
    affectedBefore: affected.map((a) => ({ id: a.id, charType: a.charType, mainCharacterId: a.mainCharacterId })),
    swappedBy: approvedBy,
    swappedAt: now,
  });

  // Only the fee moved a number; refresh that one player's standings.
  await refreshStandings(db, { playerIds: [playerId] });

  return {};
}

// post-live-test-1 LT-30 — undo a main swap: restore the pre-swap
// char_type/main_character_id of every character it re-typed, restore the
// player's main pointer, and delete the fee gp_ledger row (refunding
// exactly what was charged — 0 if it was waived). GL/admin only (the
// caller gates); no time limit. Refuses if the player's main has since
// changed again — reverse the newer swap first.
export async function reverseMainSwap(db: Db, eventId: number, reversedBy: string): Promise<SwapMainResult> {
  const [event] = await db.select().from(mainSwapEvents).where(eq(mainSwapEvents.id, eventId));
  if (!event) return { error: "Main-swap record not found." };
  if (event.reversedAt) return { error: "This main swap was already reversed." };

  const [player] = await db.select({ mainCharacterId: players.mainCharacterId }).from(players).where(eq(players.id, event.playerId));
  if (!player) return { error: "Player not found." };
  if (player.mainCharacterId !== event.newMainCharacterId) {
    return { error: "This player's main has changed since this swap — reverse the later change first." };
  }

  const now = new Date();

  for (const snap of event.affectedBefore) {
    await db
      .update(characters)
      .set({ charType: snap.charType as "main" | "alt" | "mule", mainCharacterId: snap.mainCharacterId, updatedAt: now })
      .where(eq(characters.id, snap.id));
  }

  await db
    .update(players)
    .set({
      mainCharacterId: event.prevMainCharacterId,
      mainCharacterChangedBy: reversedBy,
      mainCharacterChangedAt: now,
      updatedAt: now,
    })
    .where(eq(players.id, event.playerId));

  // Mark the event reversed and drop its fee_gp_ledger_id pointer BEFORE
  // deleting that gp_ledger row — the FK from main_swap_events would
  // otherwise block the delete. The `feeGp` amount stays on the row and
  // the ledger_audit_log "delete" entry below keeps the full record.
  await db
    .update(mainSwapEvents)
    .set({ reversedAt: now, reversedBy, feeGpLedgerId: null })
    .where(eq(mainSwapEvents.id, eventId));

  if (event.feeGpLedgerId != null) {
    const [feeRow] = await db.select().from(gpLedger).where(eq(gpLedger.id, event.feeGpLedgerId));
    if (feeRow) {
      await db.delete(gpLedger).where(eq(gpLedger.id, feeRow.id));
      await recordLedgerChange(db, "gp", feeRow.id, "delete", feeRow, null, reversedBy);
    }
  }

  await refreshStandings(db, { playerIds: [event.playerId] });

  return {};
}

// Same shape PLAN.md §11 Phase 3 task 3.5 used for every sheet-only
// character the sos_bot dump never mentioned: a standalone players row
// (discord_id NULL, main_character_id = the character itself), so a
// brand-new identity — a genuinely new main with no known player, not an
// alt of one — is claimable later (§10) rather than left with player_id
// NULL and invisible to computeEpgpTotals. Two writes, not one, the same
// way that Phase 3 backfill and characters/actions.ts's createCharacter
// are: players.main_character_id can't be set until the character row
// exists to reference, and characters.player_id can't be set until the
// player row exists to reference.
export async function createStandalonePlayer(db: Db, characterId: number, displayName: string): Promise<number> {
  const [player] = await db.insert(players).values({ displayName, status: "active" }).returning({ id: players.id });
  await db.update(players).set({ mainCharacterId: characterId }).where(eq(players.id, player.id));
  await db.update(characters).set({ playerId: player.id, updatedAt: new Date() }).where(eq(characters.id, characterId));
  return player.id;
}

// Nightly self-heal (2026-09-11, after Tunedup/Nixzard). players.
// main_character_id is the one source of truth for "which character is
// this account's main"; characters.char_type / main_character_id are the
// display copy the Roster, dashboard, parser routes and ledger-entry all
// group by. Every write path now keeps them in step (swapMainCharacter,
// reconcilePlayerMain, updateCharacter's Type guard), but a copy that can
// drift eventually will — so the nightly cron also re-derives the copy
// from the pointer:
//   1. on an account with a pointer, every other non-mule character is an
//      alt of the pointer, and the pointer's character is typed main;
//   2. on an account with NO pointer but exactly one live typed-main
//      character, the pointer is set to it (the same bootstrap
//      attachCharacterToPlayer does on claim).
// Never touches mules, never charges a fee, never writes a swap event —
// this is a display-copy repair, not a swap. EP/GP are keyed on
// ep_ledger/gp_ledger.player_id and are not involved at all.
export async function reconcileMainPointers(db: Db): Promise<{ altsRetyped: number; mainsRetyped: number; pointersSet: number }> {
  const alts = await db.run(sql`
    UPDATE characters
       SET char_type = 'alt',
           main_character_id = (SELECT p.main_character_id FROM players p WHERE p.id = characters.player_id),
           updated_at = unixepoch()
     WHERE player_id IN (SELECT id FROM players WHERE main_character_id IS NOT NULL)
       AND char_type <> 'mule'
       AND id <> (SELECT p.main_character_id FROM players p WHERE p.id = characters.player_id)
       AND (char_type <> 'alt'
            OR main_character_id IS NOT (SELECT p.main_character_id FROM players p WHERE p.id = characters.player_id))`);
  const mains = await db.run(sql`
    UPDATE characters
       SET char_type = 'main', main_character_id = NULL, updated_at = unixepoch()
     WHERE id IN (SELECT main_character_id FROM players WHERE main_character_id IS NOT NULL)
       AND (char_type <> 'main' OR main_character_id IS NOT NULL)`);
  const pointers = await db.run(sql`
    UPDATE players
       SET main_character_id = (SELECT c.id FROM characters c
                                 WHERE c.player_id = players.id AND c.char_type = 'main' AND c.status <> 'removed'),
           updated_at = unixepoch()
     WHERE main_character_id IS NULL
       AND (SELECT count(*) FROM characters c
             WHERE c.player_id = players.id AND c.char_type = 'main' AND c.status <> 'removed') = 1`);
  return {
    altsRetyped: alts.meta.changes ?? 0,
    mainsRetyped: mains.meta.changes ?? 0,
    pointersSet: pointers.meta.changes ?? 0,
  };
}

export type GuildStatusResult = { error?: string };

// Remediation plan Phase 1 (2026-09-12) — moved out of
// src/app/(app)/admin/actions.ts's private removePlayerCore/
// reinstatePlayerCore so the actual mutation logic is reachable from a
// verification script without going through a Next Server Action (which
// needs a real request/session context that a plain script doesn't have —
// see scripts/verify-guild-removal.ts). This module has no "use server"
// directive, so these are never themselves exposed as callable actions;
// admin/actions.ts's exported removeMemberFromGuild/removePlayerFromGuild/
// reinstateMember/reinstatePlayer remain the only entry points a client can
// reach, and they still do their own getSession()/redirect()/canManageRoles
// check *before* calling down into these — same division of labour as
// swapMainCharacter/reverseMainSwap above (the "use server" wrapper gates
// who may call in; the plain lib function trusts that and only enforces
// the business-data invariants below, e.g. the last-leader guard, which
// depend on the TARGET player's role, not the caller's).
//
// "Removed from the guild" is a player-level state, deliberately distinct
// from a character's own `removed` status (in-game/roster housekeeping,
// never affects access on its own — confirmed with the leader 2026-08-29).
// It does three things, all reversible by reinstatePlayerFromGuild:
//   1. drops the person's role to `member` — BOTH users.role (if they have
//      a login) and players.role (task 1.1: players.role can carry a role
//      with no linked login at all, players.role's own schema comment —
//      Koramak, an officer who'd never logged in — and syncAccountRole
//      takes the HIGHER of the two on every login, so leaving players.role
//      untouched let a demoted-then-removed officer/leader silently regain
//      their old role on their very next sign-in).
//   2. flips players.status to `departed` — (app)/layout.tsx's gate treats
//      that like a failed Discord check: no page access, bounced to
//      /access-denied. Task 1.2: this stays denied until an explicit
//      reinstatePlayerFromGuild call — see isMemberAllowed's own comment
//      for why a later login is no longer treated as proof of rejoining.
//   3. zeroes the player's EP across all their characters (a `departure`
//      decay_events batch — §1e: GP is never touched). The event id is
//      stashed on players.removalDecayEventId so reinstate can reverse it.
//   4. revokes every app API key the account holds (task 1.3) — same as
//      setUserRole's demotion path; a departed member's key stops existing,
//      not just stops passing its live canManageEpgp re-check on next use.
// Character records and GP history stay as-is. The role is NOT auto-restored
// on reinstate — a leader re-grants it deliberately.
export async function removePlayerFromGuildCore(db: Db, actingUserId: string, playerId: number): Promise<GuildStatusResult> {
  const [player] = await db
    .select({ id: players.id, userId: players.userId, status: players.status })
    .from(players)
    .where(eq(players.id, playerId));
  if (!player) return { error: "Player not found." };
  if (player.status === "departed") return { error: "This player has already been removed." };
  if (player.userId === actingUserId) {
    return { error: "You can't remove yourself — sign out instead." };
  }

  const now = new Date();
  if (player.userId !== null) {
    const [target] = await db.select({ role: users.role }).from(users).where(eq(users.id, player.userId));
    // Same last-leader guard as setUserRole: removing a leader strips their
    // role, so the guild must not be left with zero leaders/admins.
    if (target && LEADERSHIP_ROLES.includes(target.role as Role)) {
      const leaders = await db.select({ id: users.id }).from(users).where(inArray(users.role, LEADERSHIP_ROLES));
      if (leaders.length <= 1) {
        return { error: "Can't remove the only leader/admin — promote someone else first." };
      }
    }
    await db.update(users).set({ role: "member", updatedAt: now }).where(eq(users.id, player.userId));
    // Same as setUserRole's demotion path — removal always drops role to
    // "member", so any app key they held must stop existing too (leader,
    // 2026-09-05). A no-op if they never had a key.
    await revokeApiKeysForUser(db, player.userId);
  }
  // Unconditional — see the function comment above for why this can't be
  // gated on player.userId the way the users.role branch is.
  await db.update(players).set({ role: "member", updatedAt: now }).where(eq(players.id, player.id));

  // Zero their EP. `commitDepartureWipe` skips characters already at 0 EP
  // and returns an error only when nothing matched — that's not a failure
  // here, just "no EP to wipe", so removalDecayEventId stays null.
  let removalDecayEventId: number | null = null;
  const chars = await db.select({ id: characters.id }).from(characters).where(eq(characters.playerId, player.id));
  if (chars.length > 0) {
    const outcome = await commitDepartureWipe(db, {
      characterIds: chars.map((c) => c.id),
      label: "Removed from guild",
      appliedBy: actingUserId,
    });
    if (!("error" in outcome)) removalDecayEventId = outcome.decayEventId;
  }

  await db
    .update(players)
    .set({ status: "departed", departedAt: now, removalDecayEventId, statusChangedBy: actingUserId, statusChangedAt: now, updatedAt: now })
    .where(eq(players.id, player.id));

  return {};
}

// Full reverse of removePlayerFromGuildCore's EP wipe + status, but NOT the
// role (a leader re-grants that). Safe if the departure event was already
// reversed by hand on /epgp/decay — that just clears the pointer.
export async function reinstatePlayerFromGuildCore(db: Db, actingUserId: string, playerId: number): Promise<GuildStatusResult> {
  const now = new Date();
  const [player] = await db
    .select({ id: players.id, removalDecayEventId: players.removalDecayEventId })
    .from(players)
    .where(eq(players.id, playerId));
  if (!player) return { error: "Player not found." };

  if (player.removalDecayEventId != null) {
    const outcome = await reverseDecayEvent(db, player.removalDecayEventId, actingUserId);
    if ("error" in outcome && !/already reversed|not found/i.test(outcome.error)) {
      return { error: `Couldn't restore EP: ${outcome.error}` };
    }
  }

  await db
    .update(players)
    .set({ status: "active", departedAt: null, removalDecayEventId: null, statusChangedBy: actingUserId, statusChangedAt: now, updatedAt: now })
    .where(eq(players.id, player.id));

  return {};
}
