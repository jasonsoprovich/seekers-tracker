import { eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/shell/PageHeader";
import { SpellGridView, type SpellGridRow } from "@/components/spells/SpellGridView";
import { characterSpells, characters, players, users } from "@/db";
import { getDb } from "@/lib/db";
import { getPermissions } from "@/lib/permissions";
import { isRosterPlaceholder } from "@/lib/roster-visibility";
import { getSession } from "@/lib/session";
import { SPELL_CLASS_IDS } from "@/lib/spells";
import { loadHiddenSpellIds } from "@/lib/spells/db";

// Guild-wide 61-65 spell grid, one class at a time. Visible to every role
// (same transparency call as /progression); officers can flip cells in edit
// mode and hide spells guild-wide.
export default async function SpellsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const [allCharacters, spellRows, hidden, perms, [myPlayer]] = await Promise.all([
    db
      .select({
        id: characters.id,
        name: characters.name,
        classId: characters.class,
        charType: characters.charType,
        status: characters.status,
        lastActivityAt: characters.lastActivityAt,
        ownerUsername: users.username,
        ownerId: characters.ownerId,
        playerStatus: players.status,
      })
      .from(characters)
      .leftJoin(users, eq(characters.ownerId, users.id))
      .leftJoin(players, eq(players.id, characters.playerId))
      .orderBy(characters.name),
    // Whole table, not filtered by character id — same D1 bound-parameter
    // dodge as /progression.
    db
      .select({
        characterId: characterSpells.characterId,
        spellId: characterSpells.spellId,
        source: characterSpells.source,
        updatedAt: characterSpells.updatedAt,
      })
      .from(characterSpells),
    loadHiddenSpellIds(db),
    getPermissions(session.user.id),
    db.select({ mainCharacterId: players.mainCharacterId }).from(players).where(eq(players.userId, session.user.id)),
  ]);

  const byCharacter = new Map<number, { owned: number[]; updatedAt: number | null; updatedSource: string | null }>();
  for (const r of spellRows) {
    let entry = byCharacter.get(r.characterId);
    if (!entry) {
      entry = { owned: [], updatedAt: null, updatedSource: null };
      byCharacter.set(r.characterId, entry);
    }
    entry.owned.push(r.spellId);
    const t = r.updatedAt.getTime();
    if (entry.updatedAt === null || t > entry.updatedAt) {
      entry.updatedAt = t;
      entry.updatedSource = r.source;
    }
  }

  // Same visibility rules as /progression, minus mules (bank characters)
  // and classes with no 61-65 spells.
  const rows: SpellGridRow[] = allCharacters
    .filter((c) => !isRosterPlaceholder(c.name) && c.charType !== "mule" && SPELL_CLASS_IDS.includes(c.classId))
    .map((c) => {
      const s = byCharacter.get(c.id);
      return {
        id: c.id,
        name: c.name,
        ownerUsername: c.ownerUsername ?? "(no username)",
        classId: c.classId,
        charType: c.charType === "main" ? "main" : "alt",
        status: c.status,
        departed: c.playerStatus === "departed",
        lastActivityAt: c.lastActivityAt?.getTime() ?? null,
        owned: s?.owned ?? [],
        updatedAt: s?.updatedAt ?? null,
        updatedSource: s?.updatedSource ?? null,
      };
    });

  const mainClass = myPlayer?.mainCharacterId
    ? (allCharacters.find((c) => c.id === myPlayer.mainCharacterId)?.classId ?? null)
    : null;

  // Shortcut to the viewer's own Spells tabs, main first.
  const mine = allCharacters
    .filter((c) => c.ownerId === session.user.id && c.status !== "removed" && c.charType !== "mule" && SPELL_CLASS_IDS.includes(c.classId))
    .sort((a, b) => Number(b.id === myPlayer?.mainCharacterId) - Number(a.id === myPlayer?.mainCharacterId) || a.name.localeCompare(b.name));

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Spells 61–65"
        subtitle="Who has which level 61–65 class spells — pick a class to see every character against its spell list."
      />
      {mine.length > 0 && (
        <div className="mb-5 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-neutral-400">Update your spells:</span>
          {mine.map((c) => (
            <Link
              key={c.id}
              href={`/characters/${c.id}/spells`}
              className="rounded-md border border-border px-2.5 py-1 font-medium text-emerald-400 hover:border-emerald-700 hover:text-emerald-300"
            >
              {c.name}
            </Link>
          ))}
        </div>
      )}
      <SpellGridView
        rows={rows}
        hiddenIds={[...hidden]}
        defaultClassId={mainClass}
        canEdit={perms.can("characters.manageAny")}
        canHide={perms.can("spells.manage")}
        nowMs={Date.now()}
      />
    </div>
  );
}
