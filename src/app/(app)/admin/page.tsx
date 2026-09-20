import { eq } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AccountSetupQueue } from "@/components/admin/AccountSetupQueue";
import { LiveBidVisibilityControl } from "@/components/admin/LiveBidVisibilityControl";
import { ViewAsControls } from "@/components/admin/ViewAsControls";
import { PageHeader } from "@/components/shell/PageHeader";
import { characterClaims, characters, players, users } from "@/db";
import { getRealUserRole, LEADERSHIP_ROLES } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { UNKNOWN_CLASS_ID } from "@/lib/eq/enums";
import { type Capability, getPermissions } from "@/lib/permissions";
import { getSession } from "@/lib/session";

// Latest published officer-app build — the release page always redirects to
// the newest tag, so this never goes stale.
const OFFICER_APP_RELEASE_URL = "https://github.com/jasonsoprovich/seekers-epgp-parser/releases/latest";

// A link with no `capability` always shows (e.g. Claim Requests' own page
// has its own gate; System Health/Import Audit links are themselves
// gated by their target pages). `adminOnly` is for links that must never
// be tunable through the permissions matrix — the Permissions editor
// itself is the one such case (see CAPABILITY_GROUPS' comment on why it's
// deliberately excluded from the registry). `leadershipOnly` is the same
// idea for leader+admin — the System Log/Export page, which must stay
// reachable by whoever can already see every other admin control, not be
// toggleable away from a leader by an officer-tunable capability.
type AdminLink = {
  href: string;
  label: string;
  description: string;
  external?: boolean;
  badgeKey?: "pendingClaims";
  capability?: Capability;
  adminOnly?: boolean;
  leadershipOnly?: boolean;
};

const ADMIN_SECTIONS: { title: string; description: string; links: AdminLink[] }[] = [
  {
    title: "Needs Attention",
    description: "Requests and onboarding that need an officer before an account can manage itself.",
    links: [
      {
        href: "/admin/claims",
        label: "Claim Requests",
        description: "Review members requesting roster characters.",
        badgeKey: "pendingClaims",
      },
    ],
  },
  {
    title: "Operations",
    description: "Officer tools for capture, API access, and read-only data investigation.",
    links: [
      { href: OFFICER_APP_RELEASE_URL, label: "Officer App", description: "Download the current desktop capture app.", external: true, capability: "epgp.officerApi" },
      { href: "/epgp/app-key", label: "App Key", description: "Manage your parser API key.", capability: "epgp.appKey" },
      { href: "/epgp/sql", label: "SQL Sandbox", description: "Run read-only EPGP queries.", capability: "epgp.sql" },
    ],
  },
  {
    title: "EPGP",
    description: "Leader-level configuration and controlled ledger-wide changes.",
    links: [
      { href: "/epgp/settings", label: "EPGP Settings", description: "Change effective-dated guild settings.", capability: "epgp.config" },
      { href: "/epgp/decay", label: "EPGP Decay", description: "Preview, commit, or reverse decay events.", capability: "epgp.decay" },
    ],
  },
  {
    title: "System Health",
    description: "Audit recent imports and inspect read-only recovery status.",
    links: [
      { href: "/admin/health", label: "System Health / Maintenance", description: "Review standings, backups, retention, and restore points.", capability: "admin.health.view" },
      { href: "/admin/imports", label: "Import Audit Trail", description: "Review processed import history.", capability: "admin.imports.view" },
    ],
  },
  {
    title: "Access Control",
    description: "Who can do what, per role.",
    links: [
      { href: "/admin/permissions", label: "Permissions", description: "Toggle capabilities for members, officers, and leaders.", adminOnly: true },
    ],
  },
  {
    title: "Diagnostics",
    description: "Detailed change history and raw data export. Leaders and admins only.",
    links: [
      {
        href: "/admin/logs",
        label: "System Log & Export",
        description: "Every admin/officer change to the database, and CSV export of any table.",
        leadershipOnly: true,
      },
    ],
  },
];

export default async function AdminPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const perms = await getPermissions(session.user.id);
  if (!perms.can("admin.view")) redirect("/characters");

  // Real (non-preview) role, so the "Preview as" controls — and the
  // admin-only Access Control section — stay reachable regardless of which
  // role an admin currently has previewed, but never show to a real
  // officer/leader or to an admin currently previewing one.
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

      {realRole === "admin" && (
        <div className="mt-6">
          <ViewAsControls />
        </div>
      )}

      {ADMIN_SECTIONS.map((section, index) => {
        const links = section.links.filter((link) => {
          if (link.adminOnly) return realRole === "admin";
          if (link.leadershipOnly) return realRole !== null && LEADERSHIP_ROLES.includes(realRole);
          if (link.capability) return perms.can(link.capability);
          return true;
        });
        return (
          <section key={section.title} className={index === 0 ? "mt-8" : "mt-10"}>
            <h2 className="text-lg font-semibold">{section.title}</h2>
            <p className="mt-1 text-sm text-neutral-400">{section.description}</p>
            {links.length > 0 && (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {links.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    {...(link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                    className="rounded-lg border border-border px-4 py-3 transition-colors hover:border-emerald-500/60 hover:bg-neutral-900/60"
                  >
                    <span className="flex items-center gap-2 font-medium text-neutral-200">
                      {link.label}
                      {link.badgeKey === "pendingClaims" && pendingClaimCount > 0 && (
                        <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-semibold text-black">
                          {pendingClaimCount}
                        </span>
                      )}
                      {link.external && <span aria-hidden className="text-xs text-neutral-500">↗</span>}
                    </span>
                    <span className="mt-1 block text-sm text-neutral-500">{link.description}</span>
                  </Link>
                ))}
              </div>
            )}
            {section.title === "Needs Attention" && needsSetup.length > 0 && (
              <div className="mt-6">
                <h3 className="text-base font-semibold">
                  Account setup queue <span className="ml-1 text-sm font-normal text-neutral-500">{needsSetup.length}</span>
                </h3>
                <p className="mt-1 text-sm text-neutral-400">
                  Verified Discord members with no character account yet. Assign their main here, or they can claim it from Your Characters.
                </p>
                <AccountSetupQueue members={needsSetup} unclaimedCharacters={unclaimedCharacters} />
              </div>
            )}
            {section.title === "EPGP" && perms.can("epgp.liveBids.visibility") && <LiveBidVisibilityControl />}
            {section.title === "System Health" && unresolvedClassCount > 0 && (
              <p className="mt-4 text-sm text-amber-400">
                {unresolvedClassCount} character{unresolvedClassCount === 1 ? "" : "s"} still have an unknown class — filter the{" "}
                <Link href="/roster" className="text-emerald-400 hover:text-emerald-300">
                  Roster
                </Link>{" "}
                by class &quot;Unknown&quot; to find and edit them.
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}
