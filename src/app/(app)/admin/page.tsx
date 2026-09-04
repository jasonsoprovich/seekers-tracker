import { eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AdminCharacterList, type AdminCharacterRow } from "@/components/admin/AdminCharacterList";
import { RemoveMemberButton } from "@/components/admin/RemoveMemberButton";
import { MainCharacterSelect } from "@/components/MainCharacterSelect";
import { RoleSelect } from "@/components/RoleSelect";
import { PageHeader } from "@/components/shell/PageHeader";
import { characterPopFlags, characters, players, users } from "@/db";
import { canManageAnyCharacter, canManageEpgp, canManageEpgpConfig, canManageRoles, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { charClassLabel, charRaceName, UNKNOWN_CLASS_ID } from "@/lib/eq/enums";
import { resolveFlags } from "@/lib/pop-flags";
import { getSession } from "@/lib/session";

export default async function AdminPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);
  if (!canManageAnyCharacter(role)) redirect("/characters");

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

  // PLAN.md §11 Phase 10 task 10.3 — leader-only "main swap" section. Only
  // worth showing a player here if they have 2+ non-mule characters to
  // choose between (the common one-character case has nothing to swap).
  const playerRows = canEditRoles
    ? await db.select({ id: players.id, displayName: players.displayName, mainCharacterId: players.mainCharacterId }).from(players)
    : [];
  const charactersByPlayer = new Map<number, { id: number; name: string }[]>();
  if (canEditRoles) {
    for (const c of roster) {
      if (c.playerId === null || c.charType === "mule" || c.status === "removed") continue;
      if (!charactersByPlayer.has(c.playerId)) charactersByPlayer.set(c.playerId, []);
      charactersByPlayer.get(c.playerId)!.push({ id: c.id, name: c.name });
    }
  }
  const playersWithChoices = playerRows
    .map((p) => ({ ...p, options: charactersByPlayer.get(p.id) ?? [] }))
    .filter((p) => p.options.length >= 2)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

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

      <section>
        <h2 className="text-lg font-semibold">All Characters</h2>
        <p className="mt-1 text-sm text-neutral-400">
          As {role}, you can view and edit any member&apos;s character. Edit a character to change its
          main/alt status or link an alt to its main.
          {canEditRoles && " A main character's row also has a role picker, to promote/demote its owner."}
        </p>
        {unresolvedClassCount > 0 && (
          <p className="mt-2 text-sm text-amber-400">
            {unresolvedClassCount} character{unresolvedClassCount === 1 ? "" : "s"} have an unresolved class — editable per-character
            below.
          </p>
        )}
        {roster.length === 0 ? (
          <p className="mt-4 text-neutral-400">No characters have been added yet.</p>
        ) : (
          <div className="mt-4">
            <AdminCharacterList rows={rows} canEditRoles={canEditRoles} selfUserId={session.user.id} />
          </div>
        )}
      </section>

      {canEditRoles && (
        <section className="mt-10">
          <h2 className="text-lg font-semibold">Members &amp; Roles</h2>
          <p className="mt-1 text-sm text-neutral-400">
            Promote or demote members, or remove someone from the guild (strips their role, blocks all
            site access, and zeroes their EP — GP is kept — until reinstated, which restores the EP and
            access but not the role). Character records stay. Only leaders can do either.
          </p>
          <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
            {members.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="font-medium">{m.username ?? "(no username)"}</p>
                  <p className="text-sm text-neutral-500">
                    {m.discordVerified ? "Discord verified" : "Not Discord-verified"} · joined{" "}
                    {m.createdAt.toLocaleDateString()}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <RemoveMemberButton
                    userId={m.id}
                    username={m.username ?? "this member"}
                    departed={m.playerStatus === "departed"}
                    isSelf={m.id === session.user.id}
                  />
                  <RoleSelect userId={m.id} role={m.role} isSelf={m.id === session.user.id} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {canEditRoles && (
        <section className="mt-10">
          <h2 className="text-lg font-semibold">Player Main Characters</h2>
          <p className="mt-1 text-sm text-neutral-400">
            Which character each player&apos;s EP/GP priority and roster identity is anchored to. Swapping never
            touches EP/GP — those are tracked per player, not per character (PLAN.md §4a) — it only relabels which
            character is &quot;main&quot; and which are alts. Only players with more than one character are listed
            here.
          </p>
          {playersWithChoices.length === 0 ? (
            <p className="mt-4 text-neutral-400">No player currently has more than one character to choose between.</p>
          ) : (
            <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
              {playersWithChoices.map((p) => (
                <li key={p.id} className="flex items-center justify-between px-4 py-3">
                  <p className="font-medium">{p.displayName}</p>
                  <MainCharacterSelect playerId={p.id} options={p.options} currentMainCharacterId={p.mainCharacterId} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
