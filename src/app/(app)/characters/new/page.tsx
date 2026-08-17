import { redirect } from "next/navigation";

import { CharacterForm } from "@/components/CharacterForm";
import { PageHeader } from "@/components/shell/PageHeader";
import { getSession } from "@/lib/session";

import { createCharacter } from "../actions";

export default async function NewCharacterPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <div className="mx-auto max-w-md">
      <PageHeader
        breadcrumbs={[{ label: "Characters", href: "/characters" }, { label: "Add Character" }]}
        title="Add Character"
      />
      <CharacterForm action={createCharacter} submitLabel="Add Character" />
    </div>
  );
}
