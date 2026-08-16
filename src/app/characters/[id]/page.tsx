import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { PopFlagChecklist } from "@/components/PopFlagChecklist";
import { characterPopFlags, characters } from "@/db";
import { getDb } from "@/lib/db";
import { charClassLabel, charRaceName } from "@/lib/eq/enums";
import { resolveFlags } from "@/lib/pop-flags";
import { getSession } from "@/lib/session";

export default async function CharacterFlagsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const characterId = Number(id);
  if (!Number.isInteger(characterId)) notFound();

  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const [character] = await db.select().from(characters).where(eq(characters.id, characterId));
  if (!character) notFound();
  if (character.ownerId !== session.user.id) redirect("/characters");

  const rows = await db
    .select()
    .from(characterPopFlags)
    .where(eq(characterPopFlags.characterId, characterId));
  const resolved = resolveFlags(rows.map((r) => ({ flagId: r.flagId, done: r.done, source: r.source })));

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
              Import Seer Text
            </Link>
            <Link href={`/characters/${character.id}/edit`} className="text-emerald-400 hover:text-emerald-300">
              Edit
            </Link>
            <Link href="/characters" className="text-neutral-400 hover:text-neutral-300">
              Back
            </Link>
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-3">
          <p className="mb-1 text-xs tracking-wider text-neutral-500 uppercase">PoP progress</p>
          <div className="flex items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-neutral-800">
              <div
                className={`h-full rounded-full ${resolved.done === resolved.total && resolved.total > 0 ? "bg-emerald-500" : "bg-sky-500"}`}
                style={{ width: `${resolved.total === 0 ? 0 : Math.round((resolved.done / resolved.total) * 100)}%` }}
              />
            </div>
            <span className="shrink-0 text-sm text-neutral-300 tabular-nums">
              {resolved.done} / {resolved.total}
            </span>
          </div>
        </div>

        <div className="mt-6">
          <PopFlagChecklist characterId={character.id} flags={resolved.flags} tiers={resolved.tiers} />
        </div>
      </div>
    </div>
  );
}
