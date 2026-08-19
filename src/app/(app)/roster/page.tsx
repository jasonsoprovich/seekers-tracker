import { eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

import { RosterTable, type RosterRow } from "@/components/roster/RosterTable";
import { PageHeader } from "@/components/shell/PageHeader";
import { characters, users } from "@/db";
import { canManageEpgp, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { charClassLabel } from "@/lib/eq/enums";
import { computeEpgpTotals } from "@/lib/epgp/totals";
import { getSession } from "@/lib/session";

// Visible to every role (member/officer/leader) — this is a read-only view
// of the whole guild's roster, mains and alts, owned and unclaimed alike.
// Doubles as the guild's EPGP standings (the old /epgp page was dropped —
// same character set, same search/filters, so it was pure duplication).
export default async function RosterPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);
  const db = await getDb();
  const [rows, totals] = await Promise.all([
    db
      .select({
        id: characters.id,
        name: characters.name,
        ownerId: characters.ownerId,
        classId: characters.class,
        raceId: characters.race,
        level: characters.level,
        charType: characters.charType,
        status: characters.status,
        mainCharacterId: characters.mainCharacterId,
        ownerUsername: users.username,
        ownerRole: users.role,
      })
      .from(characters)
      .leftJoin(users, eq(characters.ownerId, users.id))
      .orderBy(characters.name),
    computeEpgpTotals(db),
  ]);

  // Alts don't carry their own EP/GP — loot priority is tracked per main,
  // so an alt displays whatever its main's ledger totals to.
  function totalsFor(r: (typeof rows)[number]) {
    if (r.charType === "alt" && r.mainCharacterId !== null) {
      return totals.get(r.mainCharacterId) ?? totals.get(r.id);
    }
    return totals.get(r.id);
  }

  const rosterRows: RosterRow[] = rows.map((r) => {
    const total = totalsFor(r);
    return {
      id: r.id,
      name: r.name,
      ownerUsername: r.ownerUsername,
      ownerRole: r.ownerRole,
      isClaimed: r.ownerId !== null,
      classId: r.classId,
      className: charClassLabel(r.classId),
      raceId: r.raceId,
      level: r.level,
      charType: r.charType,
      status: r.status,
      mainCharacterId: r.mainCharacterId,
      ep: total?.ep ?? null,
      gp: total?.gp ?? null,
      epDecay: total?.epDecay ?? null,
      gpDecay: total?.gpDecay ?? null,
      priorityRating: total?.priorityRating ?? null,
    };
  });

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Guild Roster"
        subtitle="Every character in the guild, mains and alts, with current EPGP standing. Search, sort, and filter below."
        actions={
          <>
            <Link href="/epgp/ledger" className="text-emerald-400 hover:text-emerald-300">
              Ledger
            </Link>
            {canManageEpgp(role) && (
              <Link href="/epgp/sql" className="text-emerald-400 hover:text-emerald-300">
                SQL Sandbox
              </Link>
            )}
          </>
        }
      />
      <RosterTable rows={rosterRows} />
    </div>
  );
}
