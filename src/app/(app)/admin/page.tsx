import { eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AdminCharacterList, type AdminCharacterRow, type PlayerMainInfo } from "@/components/admin/AdminCharacterList";
import { MembersRolesList } from "@/components/admin/MembersRolesList";
import { ViewAsControls } from "@/components/admin/ViewAsControls";
import { PageHeader } from "@/components/shell/PageHeader";
import { characterPopFlags, characters, players, users } from "@/db";
import {
  canManageAnyCharacter,
  canManageEpgp,
  canManageEpgpConfig,
  canManageRoles,
  getRealUserRole,
  getUserRole,
} from "@/lib/authz";
import { getDb } from "@/lib/db";
import { charClassLabel, charRaceName, UNKNOWN_CLASS_ID } from "@/lib/eq/enums";
import { resolveFlags } from "@/lib/pop-flags";
import { getSession } from "@/lib/session";

export default async function AdminPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);
  if (!canManageAnyCharacter(role)) redirect("/characters");

  // Real (non-preview) role, so the "Preview as" controls stay reachable
  // regardless of which role an admin currently has previewed, but never
  // show to a real officer/leader.
  const realRole = await getRealUserRole(session.user.id);

  const db = await getDb();

  const roster = await db
    .select({
      id: characters.id,
      name: characters.name,
      class: characters.class,
      race: characters.race,
      level: characters.level,
      charType: characters.charType,
      status: characters.status,
      mainCharacterId: characters.mainCharacterId,
      playerId: characters.playerId,
      ownerUsername: users.username,
      ownerId: characters.ownerId,
      ownerRole: users.role,
    })
    .from(characters)
    .leftJoin(users, eq(characters.ownerId, users.id))
    .orderBy(characters.name);

  const nameById = new Map(roster.map((c) => [c.id, c.name]));
  const unresolvedClassCount = roster.filter((c) => c.class === UNKNOWN_CLASS_ID).length;

  // Guild-wide table, not filtered by character ID list — see dashboard's
  // identical comment: an inArray() of every character's ID hits D1's
  // ~100-bound-parameter-per-statement limit once the roster grows past
  // that.
  const flagRows = await db.select().from(characterPopFlags);
  const flagsByCharacter = new Map<number, typeof flagRows>();
  for (const r of flagRows) {
    if (!flagsByCharacter.has(r.characterId)) flagsByCharacter.set(r.characterId, []);
    flagsByCharacter.get(r.characterId)!.push(r);
  }

  const rows: AdminCharacterRow[] = roster.map((c) => {
    const resolved = resolveFlags(
      (flagsByCharacter.get(c.id) ?? []).map((r) => ({
        flagId: r.flagId,
        done: r.done,
        source: r.source,
      })),
    );
    return {
      id: c.id,
      name: c.name,
      classId: c.class,
      className: charClassLabel(c.class),
      raceId: c.race,
      raceName: charRaceName(c.race),
      level: c.level,
      charType: c.charType,
      status: c.status,
      mainCharacterId: c.mainCharacterId,
      mainName: c.charType === "alt" && c.mainCharacterId ? (nameById.get(c.mainCharacterId) ?? "(unknown)") : null,
      playerId: c.playerId,
      ownerUsername: c.ownerUsername,
      ownerId: c.ownerId,
      ownerRole: c.ownerRole,
      popDone: resolved.done,
      popTotal: resolved.total,
    };
  });

  const canEditRoles = canManageRoles(role);
  const members = canEditRoles
    ? await db
        .select({
          id: users.id,
          username: users.username,
          role: users.role,
          discordVerified: users.discordVerified,
          createdAt: users.createdAt,
          // 'departed' == removed from the guild by a leader (blocks all
          // site access) — see RemoveMemberButton / removeMemberFromGuild.
          playerStatus: players.status,
        })
        .from(users)
        .leftJoin(players, eq(players.userId, users.id))
        .orderBy(users.username)
    : [];

  // PLAN.md §11 Phase 10 task 10.3 — leader-only main swap. Used to be its
  // own hundreds-of-rows section; now folded inline onto each player's
  // main-character row in the list below. Only players with 2+ non-mule
  // characters have anything to swap.
  const playerRows = canEditRoles
    ? await db.select({ id: players.id, mainCharacterId: players.mainCharacterId }).from(players)
    : [];
  const charactersByPlayer = new Map<number, { id: number; name: string }[]>();
  if (canEditRoles) {
    for (const c of roster) {
      if (c.playerId === null || c.charType === "mule" || c.status === "removed") continue;
      if (!charactersByPlayer.has(c.playerId)) charactersByPlayer.set(c.playerId, []);
      charactersByPlayer.get(c.playerId)!.push({ id: c.id, name: c.name });
    }
  }
  const playerMains: PlayerMainInfo = {};
  if (canEditRoles) {
    for (const p of playerRows) {
      const options = (charactersByPlayer.get(p.id) ?? []).sort((a, b) => a.name.localeCompare(b.name));
      if (options.length >= 2) playerMains[String(p.id)] = { currentMainCharacterId: p.mainCharacterId, options };
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Admin"
        actions={
          <>
            <Link href="/admin/claims" className="text-emerald-400 hover:text-emerald-300">
              Claim Requests
            </Link>
            <Link href="/admin/imports" className="text-emerald-400 hover:text-emerald-300">
              Import Audit Trail
            </Link>
            {canManageEpgp(role) && (
              <Link href="/epgp/app-key" className="text-emerald-400 hover:text-emerald-300">
                App Key
              </Link>
            )}
            {canManageEpgp(role) && (
              <Link href="/epgp/sql" className="text-emerald-400 hover:text-emerald-300">
                SQL Sandbox
              </Link>
            )}
            {canManageEpgpConfig(role) && (
              <Link href="/epgp/settings" className="text-emerald-400 hover:text-emerald-300">
                EPGP Settings
              </Link>
            )}
            {canManageEpgpConfig(role) && (
              <Link href="/epgp/decay" className="text-emerald-400 hover:text-emerald-300">
                EPGP Decay
              </Link>
            )}
          </>
        }
      />

      {realRole === "admin" && <ViewAsControls />}

      {/* Members & Roles: the people-level controls (role, remove/reinstate).
          Small list, its own section, kept first so it's never buried. The
          old standalone "Player Main Characters" list is gone — the main
          swap now lives inline on each player's main-character row in the
          Characters list below. */}
      {canEditRoles && (
        <section>
          <h2 className="text-lg font-semibold">Members &amp; Roles</h2>
          <p className="mt-1 text-sm text-neutral-400">
            Promote or demote members, or remove someone from the guild (strips their role, blocks all
            site access, and zeroes their EP — GP is kept — until reinstated, which restores the EP and
            access but not the role). Character records stay. Only leaders can do either.
          </p>
          <MembersRolesList members={members} selfUserId={session.user.id} />
        </section>
      )}

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Characters</h2>
        <p className="mt-1 text-sm text-neutral-400">
          Search for a character to view or edit it — main/alt status, alt→main link, class.
          {canEditRoles &&
            " A main-character row also carries its owner's role picker, and (for players with more than one character) which one is the main."}
        </p>
        {unresolvedClassCount > 0 && (
          <p className="mt-2 text-sm text-amber-400">
            {unresolvedClassCount} character{unresolvedClassCount === 1 ? "" : "s"} have an unresolved class — search to find and
            edit them per-character.
          </p>
        )}
        {roster.length === 0 ? (
          <p className="mt-4 text-neutral-400">No characters have been added yet.</p>
        ) : (
          <div className="mt-4">
            <AdminCharacterList rows={rows} canEditRoles={canEditRoles} selfUserId={session.user.id} playerMains={playerMains} />
          </div>
        )}
      </section>
    </div>
  );
}
