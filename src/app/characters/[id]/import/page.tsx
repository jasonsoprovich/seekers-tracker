import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";

import { characters } from "@/db";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";
import { ImportSeerForm } from "@/components/ImportSeerForm";

import { importSeerText } from "./actions";

export default async function ImportSeerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const characterId = Number(id);
  if (!Number.isInteger(characterId)) notFound();

  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const [character] = await db.select().from(characters).where(eq(characters.id, characterId));
  if (!character) notFound();
  if (character.ownerId !== session.user.id) redirect("/characters");

  const boundImport = importSeerText.bind(null, characterId);

  return (
    <div className="min-h-screen bg-neutral-950 px-6 py-10 text-neutral-100">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-bold">Import Seer Text — {character.name}</h1>
        <p className="mt-2 max-w-xl text-sm text-neutral-400">
          Sit and say &quot;guided meditation&quot; to the Seer Mal Nae`Shi, then paste the full reply below.
          This detects PoP flags from the qglobals it reports — it won&apos;t catch flags with no in-game
          signal (keys, kills), those are set from the checklist instead.
        </p>
        <div className="mt-8">
          <ImportSeerForm action={boundImport} />
        </div>
      </div>
    </div>
  );
}
