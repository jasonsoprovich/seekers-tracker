import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { RosterTable, type RosterRow } from "@/components/roster/RosterTable";
import { PageHeader } from "@/components/shell/PageHeader";
import { characters, users } from "@/db";
import { getDb } from "@/lib/db";
import { charClassLabel } from "@/lib/eq/enums";
import { getStandings } from "@/lib/epgp/standings";
import { getSession } from "@/lib/session";

// Visible to every role (member/officer/leader) — this is a read-only view
// of the whole guild's roster, mains and alts, owned and unclaimed alike.
// Doubles as the guild's EPGP standings (the old /epgp page was dropped —
// same character set, same search/filters, so it was pure duplication).
//
// No header actions here on purpose (2026-08-25): Ledger/SQL Sandbox/App Key
// used to live in this page's PageHeader actions slot, visible on a page
// every member can reach — App Key in particular let anyone who found this
// link get to the officer API-key page, even though that page's own gate
// (canManageEpgp) blocked non-officers once there. Ledger moves to the main
// nav; SQL Sandbox and App Key move to /admin, which already requires
// officer+ to reach at all.
export default async function RosterPage() {
  const session = await getSession();
  if (!session) redirect("/login");

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
        playerId: characters.playerId,
        ownerUsername: users.username,
        ownerRole: users.role,
      })
      .from(characters)
      .leftJoin(users, eq(characters.ownerId, users.id))
      .orderBy(characters.name),
    // Materialized standings — one ~255-row scan, always current. Carries
    // `lastActivityAt` (most recent EP/GP entry for the player's whole
    // group) so this page no longer runs its own two max() scans over the
    // full ledgers on every request.
    getStandings(db),
  ]);

  // Every character sharing a player (main, alt, mule) reads the same
  // total, so there's no alt→main resolution to do here.
  function totalsFor(r: (typeof rows)[number]) {
    return r.playerId !== null ? totals.get(r.playerId) : undefined;
  }

  const rosterRows: RosterRow[] = rows.map((r) => {
    const total = totalsFor(r);
    return {
      id: r.id,
      name: r.name,
      ownerUsername: r.ownerUsername,
      ownerRole: r.ownerRole,
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
      // The client works in ms.
      lastActivityAt: total?.lastActivityAt ? total.lastActivityAt.getTime() : null,
    };
  });

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Guild Roster"
        subtitle="Every character in the guild, mains and alts, with current EPGP standing. Search, sort, and filter below."
      />
      <RosterTable rows={rosterRows} />
    </div>
  );
}
