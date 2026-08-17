import Link from "next/link";

import { PageHeader } from "@/components/shell/PageHeader";
import { RoleBadge } from "@/components/ui/RoleBadge";
import type { characters } from "@/db";
import type { Role } from "@/lib/authz";
import { charClassLabel, charRaceName } from "@/lib/eq/enums";

import { CharacterTabs, type CharacterTabKey } from "./CharacterTabs";

type Character = Pick<typeof characters.$inferSelect, "id" | "name" | "class" | "race" | "level" | "quarmyUrl">;

// The identity header + sub-tab row shared by the three character detail
// pages (PoP checklist, gear, stats). Import and Edit are always shown here
// rather than gated per-page — the underlying permission check (ownership or
// canManageAnyCharacter) is identical for all three routes. ownerUsername/
// ownerRole are optional so callers that haven't joined `users` yet don't
// break — falls back to no owner line.
export function CharacterHeader({
  character,
  active,
  ownerUsername,
  ownerRole,
}: {
  character: Character;
  active: CharacterTabKey;
  ownerUsername?: string;
  ownerRole?: Role;
}) {
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Characters", href: "/characters" }, { label: character.name }]}
        title={character.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              Level {character.level} {charClassLabel(character.class)} — {charRaceName(character.race)}
            </span>
            {ownerUsername && (
              <span className="flex items-center gap-1.5 text-neutral-500">
                · Owned by {ownerUsername}
                {ownerRole && <RoleBadge role={ownerRole} />}
              </span>
            )}
          </span>
        }
        actions={
          <>
            {character.quarmyUrl && (
              <a
                href={character.quarmyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 hover:text-emerald-300"
              >
                Quarmy profile ↗
              </a>
            )}
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
