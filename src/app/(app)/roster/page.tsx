import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { RosterTable, type RosterRow } from "@/components/roster/RosterTable";
import { PageHeader } from "@/components/shell/PageHeader";
import { characters, users } from "@/db";
import { getDb } from "@/lib/db";
import { charClassLabel, charRaceName } from "@/lib/eq/enums";
import { computeEpgpTotals } from "@/lib/epgp/totals";
import { getSession } from "@/lib/session";

// Visible to every role (member/officer/leader) — this is a read-only view
// of the whole guild's roster, not a management surface (that's /admin).
// EP/GP here is only shown for characters with a site account (owned) — the
// full imported roster including unclaimed characters lives on /epgp.
export default async function RosterPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const [rows, totals] = await Promise.all([
    db
      .select({
        id: characters.id,
        name: characters.name,
        classId: characters.class,
        raceId: characters.race,
        level: characters.level,
        charType: characters.charType,
        ownerUsername: users.username,
        ownerRole: users.role,
      })
      .from(characters)
      .innerJoin(users, eq(characters.ownerId, users.id))
      .orderBy(characters.name),
    computeEpgpTotals(db),
  ]);

  const rosterRows: RosterRow[] = rows.map((r) => {
    const total = totals.get(r.id);
    return {
      id: r.id,
      name: r.name,
      ownerUsername: r.ownerUsername ?? "(no username)",
      ownerRole: r.ownerRole,
      classId: r.classId,
      className: charClassLabel(r.classId),
      raceId: r.raceId,
      raceName: charRaceName(r.raceId),
      level: r.level,
      charType: r.charType,
      ep: total?.ep ?? null,
      gp: total?.gp ?? null,
      priorityRating: total?.priorityRating ?? null,
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
