import { eq } from "drizzle-orm";
import type { ReactNode } from "react";

import { characterClaims } from "@/db";
import { getDb } from "@/lib/db";
import { canManageAnyCharacter, type Role } from "@/lib/authz";

import { NavBar } from "./NavBar";

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

  const links = [
    { href: "/characters", label: "Characters" },
    { href: "/roster", label: "Roster" },
    { href: "/progression", label: "Pop Progression" },
    { href: "/dashboard", label: "Dashboard" },
    ...(isManager ? [{ href: "/admin", label: "Admin", badge: pendingClaimCount || undefined }] : []),
  ];

  return (
    <div className="min-h-screen bg-surface text-neutral-100">
      <NavBar links={links} username={username} avatarUrl={avatarUrl} />
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
