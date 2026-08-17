import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";

import { CharacterHeader } from "@/components/character/CharacterHeader";
import { PopFlagChecklist } from "@/components/PopFlagChecklist";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Card } from "@/components/ui/Card";
import { characterPopFlags, characters } from "@/db";
import { canManageCharacter } from "@/lib/authz";
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
  const [character] = await db.select().from(characters).where(eq(characters.id, characterId));
  if (!character) notFound();
  if (!(await canManageCharacter(character, session.user.id))) redirect("/characters");

  const rows = await db
    .select()
    .from(characterPopFlags)
    .where(eq(characterPopFlags.characterId, characterId));
  const resolved = resolveFlags(rows.map((r) => ({ flagId: r.flagId, done: r.done, source: r.source })));

  return (
    <div className="mx-auto max-w-3xl">
      <CharacterHeader character={character} active="pop" />

      <Card className="mt-4 px-4 py-3">
        <p className="mb-1 text-xs tracking-wider text-neutral-500 uppercase">PoP progress</p>
        <ProgressBar done={resolved.done} total={resolved.total} height="md" />
      </Card>

      <div className="mt-6">
        <PopFlagChecklist characterId={character.id} flags={resolved.flags} tiers={resolved.tiers} />
      </div>
    </div>
  );
}
