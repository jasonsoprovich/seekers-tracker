import { eq } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import Link from "next/link";
import { redirect } from "next/navigation";

import { MembersRolesList } from "@/components/admin/MembersRolesList";
import { ViewAsControls } from "@/components/admin/ViewAsControls";
import { PageHeader } from "@/components/shell/PageHeader";
import { characterClaims, characters, players, users } from "@/db";
import {
  canManageAnyCharacter,
  canManageEpgp,
  canManageEpgpConfig,
  getRealUserRole,
  getUserRole,
  type Role,
} from "@/lib/authz";
import { getDb } from "@/lib/db";
import { UNKNOWN_CLASS_ID } from "@/lib/eq/enums";
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

  // Admin is about PEOPLE (site accounts, roles, claims, guild membership)
  // — characters are managed from the Roster, where every character page
  // has Edit and Account tabs (2026-09-10: the "Members & Characters"
  // list that used to live here duplicated the roster with clunkier
  // controls, and a brand-new Discord member sat at the bottom of it).
  const roster = await db
    .select({ id: characters.id, name: characters.name, class: characters.class, charType: characters.charType, status: characters.status, ownerId: characters.ownerId })
    .from(characters)
    .orderBy(characters.name);
  const unresolvedClassCount = roster.filter((c) => c.class === UNKNOWN_CLASS_ID).length;

  // The account's main character identifies an established account. A
  // verified Discord user without one stays in Admin's onboarding queue;
  // every established account is managed from its Account page via Roster.
  const mainCharacters = alias(characters, "main_characters");
  const members = await db
    .select({
      id: users.id,
      username: users.username,
      discordVerified: users.discordVerified,
      createdAt: users.createdAt,
      mainCharacterName: mainCharacters.name,
    })
    .from(users)
    .leftJoin(players, eq(players.userId, users.id))
    .leftJoin(mainCharacters, eq(mainCharacters.id, players.mainCharacterId))
    .orderBy(users.username);

  // discordVerified filters out shell accounts left by a denied sign-in
  // (someone not in the guild Discord, or with no/denied roles): the
  // membership gate already blocks them from every page. They reappear the
  // moment a real login stamps them verified.
  const verified = members.filter((m) => m.discordVerified);
  const ownerIds = new Set(roster.map((c) => c.ownerId).filter((id): id is string => id !== null));
  // The people who need an officer's attention first: signed in, in the
  // Discord, but no character on their account yet.
  const hasCharacters = (m: (typeof verified)[number]) => ownerIds.has(m.id) || m.mainCharacterName !== null;
  const needsSetup = verified.filter((m) => !hasCharacters(m));

  // Unclaimed roster characters an officer can attach to an account here.
  const unclaimedCharacters = roster
    .filter((c) => c.ownerId === null && c.status !== "removed")
    .map((c) => ({ id: c.id, name: c.name, charType: c.charType }));

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

      {needsSetup.length > 0 && (
        <section className="mt-10">
          <h2 className="text-lg font-semibold">
            New members — no character yet <span className="ml-1 text-base font-normal text-neutral-500">{needsSetup.length}</span>
          </h2>
          <p className="mt-1 text-sm text-neutral-400">
            Signed in through Discord but nothing on their account. Assign their main here (type the character name), or they can
            claim it themselves from Your Characters.
          </p>
          <MembersRolesList members={needsSetup} unclaimedCharacters={unclaimedCharacters} />
        </section>
      )}

      {unresolvedClassCount > 0 && (
        <p className="mt-10 text-sm text-amber-400">
          {unresolvedClassCount} character{unresolvedClassCount === 1 ? "" : "s"} still have an unknown class — filter the{" "}
          <Link href="/roster" className="text-emerald-400 hover:text-emerald-300">
            Roster
          </Link>{" "}
          by class &quot;Unknown&quot; to find and edit them.
        </p>
      )}
    </div>
  );
}
