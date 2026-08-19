import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";

import { CharacterHeader } from "@/components/character/CharacterHeader";
import { StatSheet } from "@/components/StatSheet";
import { EmptyState } from "@/components/ui/EmptyState";
import { characterGear, characters, characterStats, users } from "@/db";
import { canManageCharacter } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { computeDerivedStats } from "@/lib/eqstat";
import { getSession } from "@/lib/session";

export default async function CharacterStatsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const characterId = Number(id);
  if (!Number.isInteger(characterId)) notFound();

  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const [row] = await db
    .select({ character: characters, ownerUsername: users.username, ownerRole: users.role })
    .from(characters)
    .leftJoin(users, eq(characters.ownerId, users.id))
    .where(eq(characters.id, characterId));
  if (!row) notFound();
  const { character, ownerUsername, ownerRole } = row;
  const canManage = await canManageCharacter(character, session.user.id);

  const [statsRow] = await db.select().from(characterStats).where(eq(characterStats.characterId, characterId));
  const gearRows = await db.select().from(characterGear).where(eq(characterGear.characterId, characterId));

  // Always recomputed fresh from current base attributes + gear + the
  // character's live class/level/race — never trusts characterStats'
  // computed_json cache, which can go stale if the character is edited
  // between gear imports (see schema.ts's comment on the column).
  const base = statsRow
    ? {
        str: statsRow.baseStr,
        sta: statsRow.baseSta,
        agi: statsRow.baseAgi,
        dex: statsRow.baseDex,
        wis: statsRow.baseWis,
        int: statsRow.baseInt,
        cha: statsRow.baseCha,
      }
    : null;
  const derived = base
    ? computeDerivedStats({
        class: character.class,
        level: character.level,
        race: character.race,
        base,
        itemIds: gearRows.map((r) => r.itemId),
      })
    : null;

  return (
    <div className="mx-auto max-w-3xl">
      <CharacterHeader
        character={character}
        active="stats"
        ownerUsername={ownerUsername ?? undefined}
        ownerRole={ownerRole}
        canManage={canManage}
      />

      <div className="mt-6">
        {!base || !derived ? (
          <EmptyState
            message="No base attributes on file yet."
            linkHref={canManage ? `/characters/${character.id}/import` : undefined}
            linkLabel={canManage ? "Import a Quarmy export" : undefined}
            suffix=" (the modern format, with the character-stats row) to compute stats."
          />
        ) : (
          <StatSheet base={base} stats={derived} />
        )}
      </div>
    </div>
  );
}
