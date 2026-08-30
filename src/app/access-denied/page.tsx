import { eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

import { SignOutButton } from "@/components/shell/SignOutButton";
import { players, users } from "@/db";
import { getDb } from "@/lib/db";
import { isDeniedRole, parseDiscordRoleIds } from "@/lib/discord-verify";
import { getSession } from "@/lib/session";

// Where (app)/layout.tsx sends anyone the Phase 6 deny-list gate rejects.
// Outside the (app) route group on purpose — it must never itself trigger
// that layout's redirect here, which would loop.
export default async function AccessDeniedPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const [me] = await db
    .select({
      discordVerified: users.discordVerified,
      discordRoleIds: users.discordRoleIds,
      playerStatus: players.status,
    })
    .from(users)
    .leftJoin(players, eq(players.userId, users.id))
    .where(eq(users.id, session.user.id));

  const removedByLeader = me?.playerStatus === "departed";

  // Someone who's already clear of the gate landing here directly (stale
  // tab, back button after a role change took effect) has nothing to see.
  if (!removedByLeader && me?.discordVerified && !isDeniedRole(parseDiscordRoleIds(me.discordRoleIds))) {
    redirect("/characters");
  }

  const reason = removedByLeader
    ? "no longer an active member of the guild — a leader has removed your access"
    : !me?.discordVerified
      ? "not currently showing as a member of the Seekers of Souls Discord server"
      : "in the Discord server, but as an applicant (Orc Pawn) or Guest";

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center gap-6 bg-neutral-950 px-6 text-center text-neutral-100">
      <Link
        href="/"
        className="absolute top-6 left-6 text-sm font-medium text-neutral-500 hover:text-neutral-300"
      >
        ← Back to site
      </Link>
      <div className="max-w-md">
        <h1 className="text-2xl font-bold">{removedByLeader ? "Access removed" : "No site access yet"}</h1>
        <p className="mt-2 text-neutral-400">
          {removedByLeader ? (
            <>Your account is {reason}. If you think this is a mistake, reach out to a guild leader.</>
          ) : (
            <>
              Your Discord account is {reason}. The roster tracker is limited to Seekers members past
              that stage — once your role changes in Discord, signing in again picks it up
              automatically.
            </>
          )}
        </p>
      </div>
      <SignOutButton className="inline-flex items-center justify-center gap-2 rounded-full bg-neutral-800 px-6 py-3 font-semibold text-neutral-100 transition-colors hover:bg-neutral-700" />
    </div>
  );
}
