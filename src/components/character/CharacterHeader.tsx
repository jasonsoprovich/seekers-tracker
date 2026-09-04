import { PageHeader } from "@/components/shell/PageHeader";
import { CharacterStatusBadge } from "@/components/ui/CharacterStatusBadge";
import { RoleBadge } from "@/components/ui/RoleBadge";
import type { characters } from "@/db";
import type { Role } from "@/lib/authz";
import { charClassLabel, charRaceName } from "@/lib/eq/enums";

import { CharacterTabs, type CharacterTabKey } from "./CharacterTabs";

type Character = Pick<typeof characters.$inferSelect, "id" | "name" | "class" | "race" | "level" | "status">;

// The identity header + sub-tab row shared by the character detail pages.
// Edit and PoP are tabs (see CharacterTabs); Import/Gear/Stats/Quarmy are
// off the UI for now. ownerUsername/ownerRole are optional so callers that
// haven't joined `users` yet don't break — falls back to no owner line.
// `canManage` still gates whether the caller renders the Edit tab's form.
export function CharacterHeader({
  character,
  active,
  ownerUsername,
  ownerRole,
}: {
  character: Character;
  active: CharacterTabKey;
  ownerUsername?: string;
  ownerRole?: Role | null;
  canManage?: boolean;
}) {
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Characters", href: "/characters" }, { label: character.name }]}
        title={character.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="flex items-center gap-1.5">
              Level {character.level} {charClassLabel(character.class)} — {charRaceName(character.race)}
              <CharacterStatusBadge status={character.status} />
            </span>
            {ownerUsername && (
              <span className="flex items-center gap-1.5 text-neutral-500">
                · Owned by {ownerUsername}
                {ownerRole && <RoleBadge role={ownerRole} />}
              </span>
            )}
          </span>
        }
      />
      <CharacterTabs characterId={character.id} active={active} />
    </>
  );
}
