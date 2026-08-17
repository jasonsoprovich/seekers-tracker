import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppShell } from "@/components/shell/AppShell";
import { users } from "@/db";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const [me] = await db
    .select({ username: users.username, avatarUrl: users.avatarUrl, role: users.role })
    .from(users)
    .where(eq(users.id, session.user.id));

  return (
    <AppShell username={me?.username ?? "Member"} avatarUrl={me?.avatarUrl ?? null} role={me?.role ?? null}>
      {children}
    </AppShell>
  );
}
