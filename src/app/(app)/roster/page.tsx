import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { RosterTable, type RosterRow } from "@/components/roster/RosterTable";
import { PageHeader } from "@/components/shell/PageHeader";
import { characters, users } from "@/db";
import { getDb } from "@/lib/db";
import { charClassLabel } from "@/lib/eq/enums";
import { getCharacterLastActivitySince } from "@/lib/epgp/character-activity";
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
  const [rows, totals, characterActivity] = await Promise.all([
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
    // Materialized standings — one ~255-row scan, always current. EP/GP/
    // priority still come from here (genuinely per-player). `lastActivityAt`
    // does NOT — see character-activity.ts for why the "Recently active"
    // filter needs the per-character value instead.
    getStandings(db),
    getCharacterLastActivitySince(db, new Date(Date.now() - 365 * 86_400_000)),
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
      // Per-character, not the player-level total's lastActivityAt — see
      // character-activity.ts. The client works in ms.
      lastActivityAt: characterActivity.get(r.id)?.getTime() ?? null,
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
