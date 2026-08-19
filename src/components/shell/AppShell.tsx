import type { ReactNode } from "react";

import { canManageAnyCharacter, type Role } from "@/lib/authz";

import { NavBar } from "./NavBar";

export function AppShell({
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
  const links = [
    { href: "/characters", label: "Characters" },
    { href: "/roster", label: "Roster" },
    { href: "/epgp", label: "EPGP" },
    { href: "/progression", label: "Pop Progression" },
    { href: "/dashboard", label: "Dashboard" },
    ...(canManageAnyCharacter(role) ? [{ href: "/admin", label: "Admin" }] : []),
  ];

  return (
    <div className="min-h-screen bg-surface text-neutral-100">
      <NavBar links={links} username={username} avatarUrl={avatarUrl} />
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
