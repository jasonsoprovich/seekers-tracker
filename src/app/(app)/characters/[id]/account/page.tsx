import { and, desc, eq, isNull, ne, or } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { AccountCharacterRow, type AccountCharacter } from "@/components/account/AccountCharacterRow";
import { LinkToAccountPanel, type LinkCandidate } from "@/components/account/LinkToAccountPanel";
import { PlayerGuildStatusButtons } from "@/components/account/PlayerGuildStatusButtons";
import { ReverseMainSwapButton } from "@/components/admin/ReverseMainSwapButton";
import { CharacterHeader } from "@/components/character/CharacterHeader";
import { Card } from "@/components/ui/Card";
import { RoleBadge } from "@/components/ui/RoleBadge";
import { characters, mainSwapEvents, players, users } from "@/db";
import { canManageAnyCharacter, canManageCharacter, canManageRoles, getUserRole, type Role } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { getStandings } from "@/lib/epgp/standings";
import { charClassLabel, charRaceName } from "@/lib/eq/enums";
import { guildDate } from "@/lib/guild-timezone";
import { getSession } from "@/lib/session";

// /characters/[id]/account (2026-09-10) — the player-level view of any
// character: every character on the same account (main first, then alts,
// then mules), the account's live EP/GP/priority, who manages it, and the
// management actions in one place. Read-only for any member (same
// guild-wide transparency as the roster); actions are gated per control —
// see AccountCharacterRow / account/actions.ts for the tiers.
export default async function CharacterAccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const characterId = Number(id);
  if (!Number.isInteger(characterId)) notFound();

  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const [row] = await db
    .select({ character: characters, ownerUsername: users.username, ownerRole: users.role })
    .from(characters)
    .leftJoin(users, eq(characters.ownerId, users.id))
    .where(eq(characters.id, characterId));
  if (!row) notFound();
  const { character, ownerUsername, ownerRole } = row;

  const viewerRole = await getUserRole(session.user.id);
  const isOfficer = canManageAnyCharacter(viewerRole);
  const isLeader = canManageRoles(viewerRole);

  const header = (
    <CharacterHeader
      character={character}
      active="account"
      ownerUsername={ownerUsername ?? undefined}
      ownerRole={ownerRole}
      canManage={await canManageCharacter(character, session.user.id)}
    />
  );

  if (character.playerId === null) {
    return (
      <div className="mx-auto max-w-3xl">
        {header}
        <Card className="mt-6 px-4 py-4 text-sm text-neutral-400">
          <p className="font-medium text-neutral-200">This character isn&apos;t on an account yet.</p>
          <p className="mt-1">
            It has no EP/GP identity until it is. If it&apos;s yours,{" "}
            <Link href="/characters" className="text-emerald-400 hover:text-emerald-300">
              link it as an alt from Your Characters
            </Link>{" "}
            or{" "}
            <Link href="/characters/claim" className="text-emerald-400 hover:text-emerald-300">
              file a claim
            </Link>
            . An officer can link it from any other account&apos;s page.
          </p>
        </Card>
      </div>
    );
  }

  const [player] = await db
    .select({
      id: players.id,
      displayName: players.displayName,
      userId: players.userId,
      mainCharacterId: players.mainCharacterId,
      status: players.status,
      departedAt: players.departedAt,
      accountUsername: users.username,
      accountRole: users.role,
    })
    .from(players)
    .leftJoin(users, eq(players.userId, users.id))
    .where(eq(players.id, character.playerId));
  if (!player) notFound();

  const isAccountOwner = player.userId !== null && player.userId === session.user.id;

  const [members, standings, swaps] = await Promise.all([
    db
      .select({
        id: characters.id,
        name: characters.name,
        level: characters.level,
        class: characters.class,
        race: characters.race,
        charType: characters.charType,
        status: characters.status,
        ownerId: characters.ownerId,
        lastActivityAt: characters.lastActivityAt,
      })
      .from(characters)
      .where(eq(characters.playerId, player.id)),
    getStandings(db),
    db.select().from(mainSwapEvents).where(eq(mainSwapEvents.playerId, player.id)).orderBy(desc(mainSwapEvents.id)).limit(5),
  ]);

  const typeRank = (c: { id: number; charType: string }) => (c.id === player.mainCharacterId ? 0 : c.charType === "mule" ? 2 : 1);
  const list: AccountCharacter[] = members
    .slice()
    .sort((a, b) => typeRank(a) - typeRank(b) || a.name.localeCompare(b.name))
    .map((c) => ({
      id: c.id,
      name: c.name,
      level: c.level,
      className: charClassLabel(c.class),
      raceName: charRaceName(c.race),
      charType: c.charType,
      status: c.status,
      isMain: c.id === player.mainCharacterId,
      lastActivity: c.lastActivityAt ? guildDate(c.lastActivityAt) : null,
    }));
  const nameById = new Map(members.map((m) => [m.id, m.name]));
  const mainName = player.mainCharacterId ? (nameById.get(player.mainCharacterId) ?? null) : null;
  const accountName = mainName ?? player.displayName;
  const s = standings.get(player.id);

  // Candidates for "link a character": unclaimed roster characters not on
  // any real account (no owner, and either no player or a sheet-only
  // standalone player). Officer+ and the account's owner see this panel.
  let candidates: LinkCandidate[] = [];
  const canLink = isOfficer || isAccountOwner;
  if (canLink) {
    const rows = await db
      .select({
        id: characters.id,
        name: characters.name,
        level: characters.level,
        class: characters.class,
        race: characters.race,
        charType: characters.charType,
      })
      .from(characters)
      .leftJoin(players, eq(players.id, characters.playerId))
      .where(
        and(
          isNull(characters.ownerId),
          ne(characters.status, "removed"),
          or(isNull(characters.playerId), and(isNull(players.userId), isNull(players.discordId))),
          ne(characters.playerId, player.id),
        ),
      )
      .orderBy(characters.name);
    candidates = rows
      .filter((r) => r.id !== character.id)
      .map((r) => ({ id: r.id, name: r.name, level: r.level, className: charClassLabel(r.class), raceName: charRaceName(r.race), charType: r.charType }));
  }

  const latestSwap = swaps.find((e) => !e.reversedAt) ?? null;

  return (
    <div className="mx-auto max-w-3xl">
      {header}

      <Card className="mt-6 px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs tracking-wider text-neutral-500 uppercase">Account</p>
            <p className="mt-1 text-lg font-semibold text-neutral-100">{accountName}</p>
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-neutral-400">
              {player.accountUsername ? (
                <>
                  Managed by {player.accountUsername}
                  {player.accountRole && <RoleBadge role={player.accountRole as Role} />}
                </>
              ) : (
                <>Unclaimed — managed by officers until a member claims it</>
              )}
              {player.status !== "active" && (
                <span
                  className={`rounded border px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase ${
                    player.status === "departed" ? "border-red-800 bg-red-950/40 text-red-400" : "border-amber-700 bg-amber-950/40 text-amber-400"
                  }`}
                >
                  {player.status === "departed" ? `Removed${player.departedAt ? ` ${guildDate(player.departedAt)}` : ""}` : "Inactive"}
                </span>
              )}
            </p>
          </div>
          <dl className="grid grid-cols-3 gap-x-6 gap-y-1 text-right tabular-nums">
            <dt className="text-xs tracking-wider text-neutral-500 uppercase">EP</dt>
            <dt className="text-xs tracking-wider text-neutral-500 uppercase">GP</dt>
            <dt className="text-xs tracking-wider text-neutral-500 uppercase">Priority</dt>
            <dd className="text-lg font-semibold text-neutral-100">{s ? s.ep.toFixed(2) : "—"}</dd>
            <dd className="text-lg font-semibold text-neutral-100">{s ? s.gp.toFixed(2) : "—"}</dd>
            <dd className="text-lg font-semibold text-emerald-400">{s ? s.priorityRating.toFixed(4) : "—"}</dd>
          </dl>
        </div>
        <p className="mt-3 text-xs text-neutral-500">
          EP and GP belong to the account, not to any one character — every alt&apos;s attendance and every win lands here, and a main
          swap never moves history.
        </p>
      </Card>

      <section className="mt-6">
        <h2 className="text-sm font-medium tracking-wider text-neutral-500 uppercase">
          Characters on this account <span className="ml-1 text-neutral-600">{list.length}</span>
        </h2>
        <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
          {list.map((c) => {
            const member = members.find((m) => m.id === c.id);
            const ownsThis = member?.ownerId === session.user.id;
            return (
              <AccountCharacterRow
                key={c.id}
                character={c}
                playerId={player.id}
                currentId={character.id}
                canRetype={isOfficer || ownsThis || isAccountOwner}
                canPromote={isLeader}
                canUnlink={isOfficer}
              />
            );
          })}
        </ul>
        {!mainName && (
          <p className="mt-2 text-xs text-amber-400">
            This account has no main set. {isLeader ? "Use “Make main” on the character that should rank." : "Ask a leader to set one."}
          </p>
        )}
        {!isLeader && list.length > 1 && (
          <p className="mt-2 text-xs text-neutral-500">Changing which character is the main is a leader decision (500 GP, waivable).</p>
        )}
      </section>

      {canLink && <LinkToAccountPanel playerId={player.id} accountName={accountName} rows={candidates} />}

      {swaps.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-medium tracking-wider text-neutral-500 uppercase">Main swaps</h2>
          <ul className="mt-2 divide-y divide-border rounded-lg border border-border text-sm">
            {swaps.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2">
                <span className={e.reversedAt ? "text-neutral-500 line-through" : "text-neutral-300"}>
                  {guildDate(e.swappedAt)}: {e.prevMainCharacterId ? (nameById.get(e.prevMainCharacterId) ?? "previous main") : "no main"} →{" "}
                  {nameById.get(e.newMainCharacterId) ?? "new main"}
                  {e.feeGp > 0 ? ` (${e.feeGp} GP fee)` : " (fee waived)"}
                  {e.reversedAt ? ` — reversed ${guildDate(e.reversedAt)}` : ""}
                </span>
                {isLeader && latestSwap?.id === e.id && (
                  <ReverseMainSwapButton
                    eventId={e.id}
                    prevMainName={e.prevMainCharacterId ? (nameById.get(e.prevMainCharacterId) ?? null) : null}
                    newMainName={nameById.get(e.newMainCharacterId) ?? "the new main"}
                    feeGp={e.feeGp}
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {isLeader && (
        <section className="mt-8 rounded-lg border border-red-900/50 px-4 py-4">
          <h2 className="text-sm font-medium tracking-wider text-red-400 uppercase">Guild membership</h2>
          <p className="mt-1 text-sm text-neutral-400">
            {player.status === "departed"
              ? "This account was removed from the guild. Reinstating restores the zeroed EP and re-opens site access."
              : "Removing this account zeroes its EP as a departure entry (GP is kept, every character stays on record) and blocks site access. Reversible."}
          </p>
          <div className="mt-3">
            <PlayerGuildStatusButtons playerId={player.id} displayName={accountName} status={player.status} characterCount={list.length} />
          </div>
        </section>
      )}
    </div>
  );
}
