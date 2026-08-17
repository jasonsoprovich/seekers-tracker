import Link from "next/link";

import { PageHeader } from "@/components/shell/PageHeader";
import type { characters } from "@/db";
import { charClassLabel, charRaceName } from "@/lib/eq/enums";

import { CharacterTabs, type CharacterTabKey } from "./CharacterTabs";

type Character = Pick<typeof characters.$inferSelect, "id" | "name" | "class" | "race" | "level">;

// The identity header + sub-tab row shared by the three character detail
// pages (PoP checklist, gear, stats). Import and Edit are always shown here
// rather than gated per-page — the underlying permission check (ownership or
// canManageAnyCharacter) is identical for all three routes.
export function CharacterHeader({ character, active }: { character: Character; active: CharacterTabKey }) {
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Characters", href: "/characters" }, { label: character.name }]}
        title={character.name}
        subtitle={`Level ${character.level} ${charClassLabel(character.class)} — ${charRaceName(character.race)}`}
        actions={
          <>
            <Link href={`/characters/${character.id}/import`} className="text-emerald-400 hover:text-emerald-300">
              Import
            </Link>
            <Link href={`/characters/${character.id}/edit`} className="text-emerald-400 hover:text-emerald-300">
              Edit
            </Link>
          </>
        }
      />
      <CharacterTabs characterId={character.id} active={active} />
    </>
  );
}
