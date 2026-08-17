import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { StatSheet } from "@/components/StatSheet";
import { characterGear, characters, characterStats } from "@/db";
import { canManageAnyCharacter, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { charClassLabel, charRaceName } from "@/lib/eq/enums";
import { computeDerivedStats } from "@/lib/eqstat";
import { getSession } from "@/lib/session";

export default async function CharacterStatsPage({ params }: { params: Promise<{ id: string }> }) {
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
          <Link
            href={`/characters/${character.id}/gear`}
            className="border-b-2 border-transparent px-3 py-2 text-neutral-400 hover:text-neutral-200"
          >
            Gear
          </Link>
          <Link href={`/characters/${character.id}/stats`} className="border-b-2 border-emerald-500 px-3 py-2 text-neutral-100">
            Stats
          </Link>
        </div>

        <div className="mt-6">
          {!base || !derived ? (
            <p className="text-sm text-neutral-400">
              No base attributes on file yet.{" "}
              <Link href={`/characters/${character.id}/import`} className="text-emerald-400 hover:text-emerald-300">
                Import a Quarmy export
              </Link>{" "}
              (the modern format, with the character-stats row) to compute stats.
            </p>
          ) : (
            <StatSheet base={base} stats={derived} />
          )}
        </div>
      </div>
    </div>
  );
}
