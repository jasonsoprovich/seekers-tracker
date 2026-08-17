import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { RosterTable, type RosterRow } from "@/components/roster/RosterTable";
import { PageHeader } from "@/components/shell/PageHeader";
import { characterEpgp, characters, users } from "@/db";
import { getDb } from "@/lib/db";
import { charClassLabel, charRaceName } from "@/lib/eq/enums";
import { getSession } from "@/lib/session";

// Visible to every role (member/officer/leader) — this is a read-only view
// of the whole guild's roster, not a management surface (that's /admin).
export default async function RosterPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const rows = await db
    .select({
      id: characters.id,
      name: characters.name,
      classId: characters.class,
      raceId: characters.race,
      level: characters.level,
      charType: characters.charType,
      ownerUsername: users.username,
      ep: characterEpgp.ep,
      gp: characterEpgp.gp,
      priorityRating: characterEpgp.priorityRating,
    })
    .from(characters)
    .innerJoin(users, eq(characters.ownerId, users.id))
    .leftJoin(characterEpgp, eq(characterEpgp.characterId, characters.id))
    .orderBy(characters.name);

  const rosterRows: RosterRow[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    ownerUsername: r.ownerUsername ?? "(no username)",
    classId: r.classId,
    className: charClassLabel(r.classId),
    raceId: r.raceId,
    raceName: charRaceName(r.raceId),
    level: r.level,
    charType: r.charType,
    ep: r.ep,
    gp: r.gp,
    priorityRating: r.priorityRating,
  }));

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
