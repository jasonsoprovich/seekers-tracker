import { eq, isNotNull } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AdminCharacterList, type AdminCharacterRow, type PlayerMainInfo } from "@/components/admin/AdminCharacterList";
import { MembersRolesList } from "@/components/admin/MembersRolesList";
import { ViewAsControls } from "@/components/admin/ViewAsControls";
import { PageHeader } from "@/components/shell/PageHeader";
import { characterClaims, characterPopFlags, characters, players, users } from "@/db";
import {
  canManageAnyCharacter,
  canManageEpgp,
  canManageEpgpConfig,
  canManageRoles,
  getRealUserRole,
  getUserRole,
  type Role,
} from "@/lib/authz";
import { getDb } from "@/lib/db";
import { charClassLabel, charRaceName, UNKNOWN_CLASS_ID } from "@/lib/eq/enums";
import { resolveFlags } from "@/lib/pop-flags";
import { getSession } from "@/lib/session";

// Latest published officer-app build — the release page always redirects to
// the newest tag, so this never goes stale.
const OFFICER_APP_RELEASE_URL = "https://github.com/jasonsoprovich/seekers-epgp-parser/releases/latest";

const ADMIN_TABS: { href: string; label: string; external?: boolean; badgeKey?: "pendingClaims"; show: (r: Role | null) => boolean }[] = [
  { href: "/admin/claims", label: "Claim Requests", badgeKey: "pendingClaims", show: () => true },
  { href: "/admin/imports", label: "Import Audit Trail", show: () => true },
  { href: OFFICER_APP_RELEASE_URL, label: "Officer App", external: true, show: canManageEpgp },
  { href: "/epgp/app-key", label: "App Key", show: canManageEpgp },
  { href: "/epgp/sql", label: "SQL Sandbox", show: canManageEpgp },
  { href: "/epgp/settings", label: "EPGP Settings", show: canManageEpgpConfig },
  { href: "/epgp/decay", label: "EPGP Decay", show: canManageEpgpConfig },
];

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

  const pendingClaimRows = await db
    .select({ id: characterClaims.id })
    .from(characterClaims)
    .where(eq(characterClaims.status, "pending"));
  const pendingClaimCount = pendingClaimRows.length;

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

  // Owner → guild status ('departed' == removed by a leader). Small table
  // (one row per signed-in account), so a plain map, not a join.
  const playerStatusByUser = new Map(
    (await db.select({ userId: players.userId, status: players.status }).from(players).where(isNotNull(players.userId))).map(
      (r) => [r.userId as string, r.status],
    ),
  );

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
      ownerDeparted: c.ownerId ? playerStatusByUser.get(c.ownerId) === "departed" : false,
      popDone: resolved.done,
      popTotal: resolved.total,
    };
  });

  const canEditRoles = canManageRoles(role);
  // Officers (canManageAnyCharacter — already the page's own access bar) can
  // assign an unclaimed character to an account, so they need the member
  // list too; only leaders/admins get the role picker + remove button on
  // top of that.
  const members = await db
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
    .orderBy(users.username);

  // Members & Roles is merged into the character list (role picker + remove
  // on each main-character row). This fallback catches the rare account
  // that's signed in but has claimed nothing yet — otherwise unmanageable.
  // discordVerified filters out shell accounts left by a denied sign-in
  // (someone not in the guild Discord, or with no/denied roles): the
  // membership gate already blocks them from every page, so they're not
  // "members" — no reason to surface them here as if they need a character
  // assigned. They reappear the moment a real login stamps them verified.
  const ownerIds = new Set(roster.map((c) => c.ownerId).filter((id): id is string => id !== null));
  const membersNoCharacter = members.filter((m) => !ownerIds.has(m.id) && m.discordVerified);

  // Unclaimed roster characters an officer can attach to an account here.
  const unclaimedCharacters = roster
    .filter((c) => c.ownerId === null && c.status !== "removed")
    .map((c) => ({ id: c.id, name: c.name, charType: c.charType }))
    .sort((a, b) => a.name.localeCompare(b.name));

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
      <PageHeader title="Admin" />

      <nav className="mt-1 flex flex-wrap gap-2">
        {ADMIN_TABS.filter((t) => t.show(role)).map((t) => (
          <Link
            key={t.href}
            href={t.href}
            {...(t.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
            className="rounded-full border border-field px-3 py-1.5 text-sm font-medium text-neutral-300 transition-colors hover:border-emerald-500/60 hover:bg-neutral-900/60 hover:text-emerald-300"
          >
            {t.label}
            {t.badgeKey === "pendingClaims" && pendingClaimCount > 0 && (
              <span className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-semibold text-black">
                {pendingClaimCount}
              </span>
            )}
            {t.external && <span aria-hidden className="ml-1 text-xs text-neutral-500">↗</span>}
          </Link>
        ))}
      </nav>

      {realRole === "admin" && (
        <div className="mt-6">
          <ViewAsControls />
        </div>
      )}

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Members &amp; Characters</h2>
        <p className="mt-1 text-sm text-neutral-400">
          Search for a character to view or edit it — main/alt status, alt→main link, class.
          {canEditRoles &&
            " A main-character row also carries its owner's role picker, remove-from-guild, and (for players with more than one character) which one is the main."}
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

      {membersNoCharacter.length > 0 && (
        <section className="mt-10">
          <h2 className="text-lg font-semibold">Members without a claimed character</h2>
          <p className="mt-1 text-sm text-neutral-400">
            Signed in, but haven&apos;t claimed a character yet — so they don&apos;t appear in the list above. Assign one to
            them directly{canEditRoles ? ", or use the role / remove controls" : ""}.
          </p>
          <MembersRolesList
            members={membersNoCharacter}
            selfUserId={session.user.id}
            canEditRoles={canEditRoles}
            unclaimedCharacters={unclaimedCharacters}
          />
        </section>
      )}
    </div>
  );
}
