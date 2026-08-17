import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { ClaimLeaderButton } from "@/components/ClaimLeaderButton";
import { users } from "@/db";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";

export default async function BootstrapLeaderPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const [existingLeader] = await db.select({ id: users.id }).from(users).where(eq(users.role, "leader"));

  if (existingLeader) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-950 px-6 text-center text-neutral-100">
        <div className="max-w-sm">
          <h1 className="text-xl font-bold">A leader already exists</h1>
          <p className="mt-2 text-neutral-400">Ask an existing leader to promote you from the Admin panel.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 px-6 text-center text-neutral-100">
      <div className="max-w-sm">
        <h1 className="text-xl font-bold">Claim the leader role</h1>
        <p className="mt-2 text-neutral-400">
          No one leads Seekers of Souls yet. As the first person here, you can claim the leader role to bootstrap
          role management — you&apos;ll be able to promote others from Admin afterward.
        </p>
        <div className="mt-6">
          <ClaimLeaderButton />
        </div>
      </div>
    </div>
  );
}
