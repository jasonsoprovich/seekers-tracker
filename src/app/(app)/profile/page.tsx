import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { ProfileTimezoneForm } from "@/components/ProfileTimezoneForm";
import { PageHeader } from "@/components/shell/PageHeader";
import { users } from "@/db";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";

export default async function ProfilePage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const [me] = await db.select({ username: users.username, timezone: users.timezone }).from(users).where(eq(users.id, session.user.id));

  return (
    <div className="mx-auto max-w-lg">
      <PageHeader title="Profile" subtitle={me?.username ?? undefined} />

      <section className="mt-4 rounded-lg border border-border p-4">
        <h2 className="text-base font-semibold">Display timezone</h2>
        <p className="mt-1 text-sm text-neutral-400">
          Only changes how dates/times are shown to you — the guild's own schedule (raid nights, cycle dates) always
          runs on Eastern time regardless of this setting.
        </p>
        <div className="mt-3">
          <ProfileTimezoneForm currentTimezone={me?.timezone ?? null} />
        </div>
      </section>
    </div>
  );
}
