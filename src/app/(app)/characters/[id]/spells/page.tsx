import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";

import { CharacterHeader } from "@/components/character/CharacterHeader";
import { ImportSpellbookForm } from "@/components/spells/ImportSpellbookForm";
import { SpellChecklist } from "@/components/spells/SpellChecklist";
import { Card } from "@/components/ui/Card";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { characters, users } from "@/db";
import { getDb } from "@/lib/db";
import { canManageCharacter, getPermissions } from "@/lib/permissions";
import { getSession } from "@/lib/session";
import { spellsForClass } from "@/lib/spells";
import { loadCharacterSpells, loadHiddenSpellIds } from "@/lib/spells/db";

import { importZealSpellbook } from "./actions";

export default async function CharacterSpellsPage({ params }: { params: Promise<{ id: string }> }) {
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

  const [canManage, perms, ownedRows, hidden] = await Promise.all([
    canManageCharacter(character, session.user.id),
    getPermissions(session.user.id),
    loadCharacterSpells(db, characterId),
    loadHiddenSpellIds(db),
  ]);

  const spells = spellsForClass(character.class);
  const owned: Record<number, string> = {};
  for (const r of ownedRows) owned[r.spellId] = r.source;
  const counted = spells.filter((s) => !hidden.has(s.spellId));
  const done = counted.filter((s) => owned[s.spellId] !== undefined).length;
  const boundImport = importZealSpellbook.bind(null, characterId);

  return (
    <div className="mx-auto max-w-3xl">
      <CharacterHeader
        character={character}
        active="spells"
        ownerUsername={ownerUsername ?? undefined}
        ownerRole={ownerRole}
        canManage={canManage}
      />

      <Card className="mt-4 px-4 py-3">
        <p className="mb-1 text-xs tracking-wider text-neutral-500 uppercase">Level 61–65 spells</p>
        <ProgressBar done={done} total={counted.length} height="md" />
      </Card>

      {canManage && spells.length > 0 && (
        <details className="mt-4 rounded-lg border border-neutral-800 bg-neutral-900/40">
          <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-emerald-400 hover:text-emerald-300">
            Import from Zeal spellbook export
          </summary>
          <div className="border-t border-neutral-800 px-4 py-4">
            <ImportSpellbookForm action={boundImport} characterName={character.name} />
          </div>
        </details>
      )}

      <div className="mt-6">
        <SpellChecklist
          // Remount after an import so the optimistic state picks up new rows.
          key={ownedRows.length}
          characterId={character.id}
          spells={spells}
          owned={owned}
          hiddenIds={[...hidden]}
          showHidden={perms.can("spells.manage")}
          readOnly={!canManage}
        />
      </div>
    </div>
  );
}
