import { and, eq, ne } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";

import { CharacterForm } from "@/components/CharacterForm";
import { PageHeader } from "@/components/shell/PageHeader";
import { characters, users } from "@/db";
import { canManageCharacter } from "@/lib/authz";
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
  if (!(await canManageCharacter(character, session.user.id))) redirect("/characters");

  const mainCandidates = await db
    .select({ id: characters.id, name: characters.name, ownerUsername: users.username })
    .from(characters)
    .leftJoin(users, eq(characters.ownerId, users.id))
    .where(and(eq(characters.charType, "main"), ne(characters.id, characterId)))
    .orderBy(characters.name);

  const boundUpdate = updateCharacter.bind(null, characterId);

  return (
    <div className="mx-auto max-w-md">
      <PageHeader
        breadcrumbs={[
          { label: "Characters", href: "/characters" },
          { label: character.name, href: `/characters/${character.id}` },
          { label: "Edit" },
        ]}
        title={`Edit ${character.name}`}
      />
      <CharacterForm
        action={boundUpdate}
        character={character}
        mainCandidates={mainCandidates.map((m) => ({ ...m, ownerUsername: m.ownerUsername ?? "(no username)" }))}
        submitLabel="Save Changes"
      />
    </div>
  );
}
