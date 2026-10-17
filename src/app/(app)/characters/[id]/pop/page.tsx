import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { CharacterHeader } from "@/components/character/CharacterHeader";
import { PopFlagChecklist } from "@/components/PopFlagChecklist";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Card } from "@/components/ui/Card";
import { characterPopFlags, characters, users } from "@/db";
import { canManageCharacter } from "@/lib/permissions";
import { getDb } from "@/lib/db";
import { resolveFlags } from "@/lib/pop-flags";
import { getSession } from "@/lib/session";

export default async function CharacterFlagsPage({ params }: { params: Promise<{ id: string }> }) {
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

  const rows = await db.select().from(characterPopFlags).where(eq(characterPopFlags.characterId, characterId));
  const states = rows.map((r) => ({ flagId: r.flagId, done: r.done, source: r.source }));
  const resolved = resolveFlags(states);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mx-auto max-w-3xl">
      <CharacterHeader
        character={character}
        active="pop"
        ownerUsername={ownerUsername ?? undefined}
        ownerRole={ownerRole}
        canManage={canManage}
      />

      {character.ownerId === null && (
        <p className="mt-4 text-sm text-neutral-500">
          This character hasn&apos;t been claimed yet —{" "}
          <a href={`/characters/${character.id}/edit`} className="text-emerald-400 hover:text-emerald-300">
            claim it from Edit
          </a>
          .
        </p>
      )}

      <Card className="mt-4 px-4 py-3">
        <div className="mb-1 flex items-center justify-between gap-4">
          <p className="text-xs tracking-wider text-neutral-500 uppercase">PoP progress</p>
          {canManage && (
            <Link href={`/characters/${character.id}/import?tab=pqc`} className="text-sm font-medium text-emerald-400 hover:text-emerald-300">
              Import from pq-companion
            </Link>
          )}
        </div>
        <ProgressBar done={resolved.done} total={resolved.total} height="md" />
      </Card>
      </div>

      <div className="mt-6">
        <PopFlagChecklist characterId={character.id} states={states} readOnly={!canManage} />
      </div>
    </div>
  );
}
