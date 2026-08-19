import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { CharacterForm } from "@/components/CharacterForm";
import { PageHeader } from "@/components/shell/PageHeader";
import { characters, users } from "@/db";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";

import { createCharacter } from "../actions";

export default async function NewCharacterPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const mainCandidates = await db
    .select({ id: characters.id, name: characters.name, ownerUsername: users.username })
    .from(characters)
    .leftJoin(users, eq(characters.ownerId, users.id))
    .where(eq(characters.charType, "main"))
    .orderBy(characters.name);

  return (
    <div className="mx-auto max-w-md">
      <PageHeader
        breadcrumbs={[{ label: "Characters", href: "/characters" }, { label: "Add Character" }]}
        title="Add Character"
      />
      <CharacterForm
        action={createCharacter}
        mainCandidates={mainCandidates.map((m) => ({ ...m, ownerUsername: m.ownerUsername ?? "(no username)" }))}
        submitLabel="Add Character"
      />
    </div>
  );
}
