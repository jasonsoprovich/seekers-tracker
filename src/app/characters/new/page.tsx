import { redirect } from "next/navigation";

import { CharacterForm } from "@/components/CharacterForm";
import { getSession } from "@/lib/session";

import { createCharacter } from "../actions";

export default async function NewCharacterPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <div className="min-h-screen bg-neutral-950 px-6 py-10 text-neutral-100">
      <div className="mx-auto max-w-md">
        <h1 className="text-2xl font-bold">Add Character</h1>
        <div className="mt-8">
          <CharacterForm action={createCharacter} submitLabel="Add Character" />
        </div>
      </div>
    </div>
  );
}
