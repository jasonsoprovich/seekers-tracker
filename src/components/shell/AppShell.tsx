import { eq } from "drizzle-orm";
import type { ReactNode } from "react";

import { characterClaims } from "@/db";
import type { Role } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { type Capability, type PermissionMatrix, roleCan } from "@/lib/permissions";

import { Sidebar } from "./Sidebar";

// capability: undefined means every role sees the link; otherwise the
// current role must pass that capability against `matrix`. Filtered
// server-side below, so a member's client bundle never even receives an
// officer-only href.
type NavLinkDef = { href: string; label: string; badge?: number; capability?: Capability };

export async function AppShell({
  username,
  avatarUrl,
  role,
  matrix,
  children,
}: {
  username: string;
  avatarUrl: string | null;
  role: Role | null;
  matrix: PermissionMatrix;
  children: ReactNode;
}) {
  const isManager = roleCan(matrix, role, "admin.view");
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
    { href: "/admin", label: "Admin", badge: pendingClaimCount || undefined, capability: "admin.view" },
  ];
  const links = allLinks.filter((l) => !l.capability || roleCan(matrix, role, l.capability));

  return (
    // Column on mobile (the top bar sits above <main> in normal document
    // flow) so the row-flex desktop layout — the sidebar beside <main> —
    // only applies once the sidebar itself actually renders as a row
    // sibling at the sm breakpoint. Before this, the container was always
    // `flex` (row) even on mobile, and the mobile-only top bar rendered by
    // Sidebar was squeezed into a row alongside <main> instead of
    // stacking above it.
    <div className="flex min-h-screen flex-col bg-surface text-neutral-100 sm:flex-row">
      <Sidebar links={links} username={username} avatarUrl={avatarUrl} />
      <main className="min-w-0 flex-1 px-4 py-5 sm:px-6 sm:py-8">{children}</main>
    </div>
  );
}
