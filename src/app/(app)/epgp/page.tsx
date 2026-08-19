import { eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

import { StandingsTable, type StandingsRow } from "@/components/epgp/StandingsTable";
import { PageHeader } from "@/components/shell/PageHeader";
import { characters, users } from "@/db";
import { canManageEpgp, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { charClassLabel } from "@/lib/eq/enums";
import { computeEpgpTotals, getEpgpSettings } from "@/lib/epgp/totals";
import { getSession } from "@/lib/session";

// Visible to every role — the guild-wide EPGP standings this replaces the
// Google Sheet's Totals tab for. Includes unclaimed roster characters
// (owner_id null) imported from the sheet, not just ones with a site
// account, since "who's actually got priority on this drop" needs the
// whole roster, not just people who've logged in.
export default async function EpgpPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);
  const db = await getDb();

  const [rows, totals, settings] = await Promise.all([
    db
      .select({
        id: characters.id,
        name: characters.name,
        classId: characters.class,
        level: characters.level,
        charType: characters.charType,
        ownerUsername: users.username,
      })
      .from(characters)
      .leftJoin(users, eq(characters.ownerId, users.id))
      .orderBy(characters.name),
    computeEpgpTotals(db),
    getEpgpSettings(db),
  ]);

  const defaultPriority = settings.base_ep / settings.base_gp;
  const standingsRows: StandingsRow[] = rows.map((r) => {
    const total = totals.get(r.id);
    return {
      id: r.id,
      name: r.name,
      classId: r.classId,
      className: charClassLabel(r.classId),
      level: r.level,
      charType: r.charType,
      ownerUsername: r.ownerUsername,
      ep: total?.ep ?? 0,
      gp: total?.gp ?? 0,
      priorityRating: total?.priorityRating ?? defaultPriority,
    };
  });

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="EPGP Standings"
        subtitle="Effort Points / Gear Points loot priority for the whole guild, computed live from the EP and GP ledgers."
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
      <StandingsTable rows={standingsRows} />
    </div>
  );
}
