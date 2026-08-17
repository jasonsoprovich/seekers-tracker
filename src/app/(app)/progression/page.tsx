import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { PopProgressionView, type ProgressionRow } from "@/components/progression/PopProgressionView";
import { PageHeader } from "@/components/shell/PageHeader";
import { characterPopFlags, characters, users } from "@/db";
import { charClassLabel } from "@/lib/eq/enums";
import { getZoneCatalog, resolveFlags, tierLabel, zoneStatuses } from "@/lib/pop-flags";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";

// Visible to every role, read-only — same "guild-wide transparency" call as
// /roster: officers need this to see who's behind or ready to raid a given
// zone, but any member benefits from seeing where their own alts stand
// relative to the guild.
export default async function ProgressionPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const allCharacters = await db
    .select({
      id: characters.id,
      name: characters.name,
      classId: characters.class,
      level: characters.level,
      charType: characters.charType,
      ownerUsername: users.username,
    })
    .from(characters)
    .innerJoin(users, eq(characters.ownerId, users.id))
    .orderBy(characters.name);

  // Guild-wide table, not filtered by character ID list — same D1
  // bound-parameter-limit dodge as the dashboard and admin pages.
  const flagRows = await db.select().from(characterPopFlags);
  const flagsByCharacter = new Map<number, typeof flagRows>();
  for (const r of flagRows) {
    if (!flagsByCharacter.has(r.characterId)) flagsByCharacter.set(r.characterId, []);
    flagsByCharacter.get(r.characterId)!.push(r);
  }

  const rows: ProgressionRow[] = allCharacters.map((c) => {
    const resolved = resolveFlags(
      (flagsByCharacter.get(c.id) ?? []).map((r) => ({ flagId: r.flagId, done: r.done, source: r.source })),
    );
    return {
      id: c.id,
      name: c.name,
      ownerUsername: c.ownerUsername ?? "(no username)",
      classId: c.classId,
      className: charClassLabel(c.classId),
      level: c.level,
      charType: c.charType,
      done: resolved.done,
      total: resolved.total,
      tiers: resolved.tiers.map((t) => ({ tier: t.tier ?? 0, label: tierLabel(t.tier ?? 0), done: t.done, total: t.total })),
      zones: zoneStatuses(resolved),
    };
  });

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Pop Progression"
        subtitle="Every character's Planes of Power flagging, at a glance — search, filter, and see which zones are unlocked."
      />
      <PopProgressionView rows={rows} zoneCatalog={getZoneCatalog()} />
    </div>
  );
}
