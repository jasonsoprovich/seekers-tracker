import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { GearList } from "@/components/GearList";
import { characterGear, characters } from "@/db";
import { canManageAnyCharacter, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { charClassLabel, charRaceName } from "@/lib/eq/enums";
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
  if (character.ownerId !== session.user.id) {
    const role = await getUserRole(session.user.id);
    if (!canManageAnyCharacter(role)) redirect("/characters");
  }

  const rows = await db.select().from(characterGear).where(eq(characterGear.characterId, characterId));

  return (
    <div className="min-h-screen bg-neutral-950 px-6 py-10 text-neutral-100">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">{character.name}</h1>
            <p className="mt-1 text-sm text-neutral-400">
              Level {character.level} {charClassLabel(character.class)} — {charRaceName(character.race)}
            </p>
          </div>
          <div className="flex items-center gap-4 text-sm font-medium">
            <Link href={`/characters/${character.id}/import`} className="text-emerald-400 hover:text-emerald-300">
              Import
            </Link>
            <Link href="/characters" className="text-neutral-400 hover:text-neutral-300">
              Back
            </Link>
          </div>
        </div>

        <div className="mt-6 flex gap-1 border-b border-neutral-800 text-sm font-medium">
          <Link
            href={`/characters/${character.id}`}
            className="border-b-2 border-transparent px-3 py-2 text-neutral-400 hover:text-neutral-200"
          >
            PoP Checklist
          </Link>
          <Link href={`/characters/${character.id}/gear`} className="border-b-2 border-emerald-500 px-3 py-2 text-neutral-100">
            Gear
          </Link>
        </div>

        <div className="mt-6">
          {rows.length === 0 ? (
            <p className="text-sm text-neutral-400">
              No gear imported yet.{" "}
              <Link href={`/characters/${character.id}/import`} className="text-emerald-400 hover:text-emerald-300">
                Import a Quarmy export
              </Link>{" "}
              to populate this list.
            </p>
          ) : (
            <GearList rows={rows.map((r) => ({ slot: r.slot, itemName: r.itemName }))} />
          )}
        </div>
      </div>
    </div>
  );
}
