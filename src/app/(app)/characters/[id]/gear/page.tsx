import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";

import { CharacterHeader } from "@/components/character/CharacterHeader";
import { GearList } from "@/components/GearList";
import { EmptyState } from "@/components/ui/EmptyState";
import { characterGear, characters } from "@/db";
import { canManageCharacter } from "@/lib/authz";
import { formatItemStatLines, getItemStats } from "@/lib/eqstat";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";

export default async function CharacterGearPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const characterId = Number(id);
  if (!Number.isInteger(characterId)) notFound();

  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const [character] = await db.select().from(characters).where(eq(characters.id, characterId));
  if (!character) notFound();
  if (!(await canManageCharacter(character, session.user.id))) redirect("/characters");

  const rows = await db.select().from(characterGear).where(eq(characterGear.characterId, characterId));

  return (
    <div className="mx-auto max-w-3xl">
      <CharacterHeader character={character} active="gear" />

      <div className="mt-6">
        {rows.length === 0 ? (
          <EmptyState
            message="No gear imported yet."
            linkHref={`/characters/${character.id}/import`}
            linkLabel="Import a Quarmy export"
            suffix=" to populate this list."
          />
        ) : (
          <GearList
            rows={rows.map((r) => ({
              slot: r.slot,
              itemName: r.itemName,
              itemId: r.itemId,
              stats: formatItemStatLines(getItemStats(r.itemId) ?? {}),
            }))}
          />
        )}
      </div>
    </div>
  );
}
