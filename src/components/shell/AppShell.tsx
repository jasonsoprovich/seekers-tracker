import { eq } from "drizzle-orm";
import type { ReactNode } from "react";

import { characterClaims } from "@/db";
import { getDb } from "@/lib/db";
import { canManageAnyCharacter, type Role } from "@/lib/authz";

import { Sidebar } from "./Sidebar";

// roles: undefined means every role sees the link; otherwise the current
// role must be in the list. Filtered server-side below, so a member's
// client bundle never even receives an officer-only href.
type NavLinkDef = { href: string; label: string; badge?: number; roles?: Role[] };

export async function AppShell({
  username,
  avatarUrl,
  role,
  children,
}: {
  username: string;
  avatarUrl: string | null;
  role: Role | null;
  children: ReactNode;
}) {
  const isManager = canManageAnyCharacter(role);
  let pendingClaimCount = 0;
  if (isManager) {
    const db = await getDb();
    const rows = await db.select({ id: characterClaims.id }).from(characterClaims).where(eq(characterClaims.status, "pending"));
    pendingClaimCount = rows.length;
  }

  const allLinks: NavLinkDef[] = [
    { href: "/characters", label: "Your Characters" },
    { href: "/roster", label: "Roster" },
    { href: "/epgp/ledger", label: "EPGP Ledger" },
    { href: "/epgp/raids", label: "Raids & Events" },
    { href: "/epgp/info", label: "Cycle & Rules Info" },
    { href: "/bank", label: "Bank" },
    { href: "/progression", label: "Pop Progression" },
    { href: "/live-bids", label: "Live Bids" },
    { href: "/dashboard", label: "Dashboard" },
    { href: "/admin", label: "Admin", badge: pendingClaimCount || undefined, roles: ["officer", "leader", "admin"] },
  ];
  const links = allLinks.filter((l) => !l.roles || l.roles.includes(role as Role));

  return (
    <div className="flex min-h-screen bg-surface text-neutral-100">
      <Sidebar links={links} username={username} avatarUrl={avatarUrl} />
      <main className="min-w-0 flex-1 px-6 py-8">{children}</main>
    </div>
  );
}
