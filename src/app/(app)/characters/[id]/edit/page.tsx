import { and, eq, ne } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";

import { CharacterHeader } from "@/components/character/CharacterHeader";
import { CharacterForm } from "@/components/CharacterForm";
import { ClaimThisCharacterButton } from "@/components/characters/ClaimThisCharacterButton";
import { Card } from "@/components/ui/Card";
import { characterClaims, characters, users } from "@/db";
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
  const [row] = await db
    .select({ character: characters, ownerUsername: users.username, ownerRole: users.role })
    .from(characters)
    .leftJoin(users, eq(characters.ownerId, users.id))
    .where(eq(characters.id, characterId));
  if (!row) notFound();
  const { character, ownerUsername, ownerRole } = row;

  const isUnclaimed = character.ownerId === null;
  const canManage = await canManageCharacter(character, session.user.id);
  // An unclaimed character has no owner yet, so canManageCharacter is
  // false for everyone but an officer — that used to redirect any regular
  // member straight back out before they could even see a claim prompt
  // here (leader, 2026-09-05: claiming belongs on Edit, not PoP Checklist,
  // where it lived instead). Let anyone in far enough to claim it; only
  // block when someone else already owns it and the viewer isn't an
  // officer.
  if (!isUnclaimed && !canManage) redirect(`/characters/${characterId}`);

  const [mainCandidates, existingClaim] = await Promise.all([
    db
      .select({ id: characters.id, name: characters.name, ownerUsername: users.username })
      .from(characters)
      .leftJoin(users, eq(characters.ownerId, users.id))
      .where(and(eq(characters.charType, "main"), ne(characters.id, characterId)))
      .orderBy(characters.name),
    isUnclaimed
      ? db
          .select({ id: characterClaims.id })
          .from(characterClaims)
          .where(
            and(
              eq(characterClaims.characterId, characterId),
              eq(characterClaims.requesterId, session.user.id),
              eq(characterClaims.status, "pending"),
            ),
          )
      : Promise.resolve([]),
  ]);

  const boundUpdate = updateCharacter.bind(null, characterId);

  return (
    <div className="mx-auto max-w-3xl">
      <CharacterHeader character={character} active="edit" ownerUsername={ownerUsername ?? undefined} ownerRole={ownerRole} />

      {isUnclaimed && (
        <Card className="mx-auto mt-6 max-w-md px-4 py-3">
          <p className="mb-2 text-sm text-neutral-300">This character hasn&apos;t been claimed yet.</p>
          <ClaimThisCharacterButton characterId={character.id} alreadyPending={existingClaim.length > 0} />
        </Card>
      )}

      {canManage && (
        <div className="mx-auto mt-6 max-w-md">
          <CharacterForm
            action={boundUpdate}
            character={character}
            mainCandidates={mainCandidates.map((m) => ({ ...m, ownerUsername: m.ownerUsername ?? "(no username)" }))}
            submitLabel="Save Changes"
          />
        </div>
      )}
    </div>
  );
}
