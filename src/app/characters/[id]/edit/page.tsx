import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";

import { CharacterForm } from "@/components/CharacterForm";
import { characters } from "@/db";
import { canManageAnyCharacter, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";

import { updateCharacter } from "../../actions";

export default async function EditCharacterPage({ params }: { params: Promise<{ id: string }> }) {
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

  const boundUpdate = updateCharacter.bind(null, characterId);

  return (
    <div className="min-h-screen bg-neutral-950 px-6 py-10 text-neutral-100">
      <div className="mx-auto max-w-md">
        <h1 className="text-2xl font-bold">Edit {character.name}</h1>
        <div className="mt-8">
          <CharacterForm action={boundUpdate} character={character} submitLabel="Save Changes" />
        </div>
      </div>
    </div>
  );
}
