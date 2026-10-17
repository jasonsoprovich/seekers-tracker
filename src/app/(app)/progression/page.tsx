import { eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

import { PopProgressionView, type ProgressionRow } from "@/components/progression/PopProgressionView";
import { PageHeader } from "@/components/shell/PageHeader";
import { characterPopFlags, characters, players, users } from "@/db";
import { charClassLabel } from "@/lib/eq/enums";
import { getZoneCatalog, resolveFlags, tierLabel, zoneStatuses } from "@/lib/pop-flags";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";

// Visible to every role, read-only — same "guild-wide transparency" call as
// /roster: officers need this to see who's behind or ready to raid a given
// zone, but any member benefits from seeing where their own alts stand
// relative to the guild.
export default async function ProgressionPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const allCharacters = await db
    .select({
      id: characters.id,
      name: characters.name,
      classId: characters.class,
      level: characters.level,
      charType: characters.charType,
      status: characters.status,
      // Materialized per-character last activity (schema.ts) — backs the
      // "Recently active" default so 790 rows aren't rendered at once.
      lastActivityAt: characters.lastActivityAt,
      ownerUsername: users.username,
      ownerId: characters.ownerId,
    })
    .from(characters)
    .leftJoin(users, eq(characters.ownerId, users.id))
    .orderBy(characters.name);

  // Guild-wide table, not filtered by character ID list — same D1
  // bound-parameter-limit dodge as the dashboard and admin pages.
  const flagRows = await db.select().from(characterPopFlags);
  const flagsByCharacter = new Map<number, typeof flagRows>();
  for (const r of flagRows) {
    if (!flagsByCharacter.has(r.characterId)) flagsByCharacter.set(r.characterId, []);
    flagsByCharacter.get(r.characterId)!.push(r);
  }

  const rows: ProgressionRow[] = allCharacters.map((c) => {
    const resolved = resolveFlags(
      (flagsByCharacter.get(c.id) ?? []).map((r) => ({ flagId: r.flagId, done: r.done, source: r.source })),
    );
    return {
      id: c.id,
      name: c.name,
      ownerUsername: c.ownerUsername ?? "(no username)",
      classId: c.classId,
      className: charClassLabel(c.classId),
      level: c.level,
      charType: c.charType,
      status: c.status,
      done: resolved.done,
      total: resolved.total,
      lastActivityAt: c.lastActivityAt?.getTime() ?? null,
      tiers: resolved.tiers.map((t) => ({ tier: t.tier ?? 0, label: tierLabel(t.tier ?? 0), done: t.done, total: t.total })),
      zones: zoneStatuses(resolved),
    };
  });

  // Shortcut to the viewer's own checklists — this page is read-only, the
  // editing happens on each character's PoP tab. Main first, then alts,
  // then mules (same order as /characters).
  const [myPlayer] = await db
    .select({ mainCharacterId: players.mainCharacterId })
    .from(players)
    .where(eq(players.userId, session.user.id));
  const typeRank = (c: (typeof allCharacters)[number]) =>
    c.id === myPlayer?.mainCharacterId || c.charType === "main" ? 0 : c.charType === "mule" ? 2 : 1;
  const mine = allCharacters
    .filter((c) => c.ownerId === session.user.id && c.status !== "removed")
    .sort((a, b) => typeRank(a) - typeRank(b) || a.name.localeCompare(b.name));

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="PoP Progression"
        subtitle="Every character's Planes of Power flagging, at a glance — search, filter, and see which zones are unlocked."
      />
      {mine.length > 0 && (
        <div className="mb-5 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-neutral-400">Update your flags:</span>
          {mine.map((c) => (
            <Link
              key={c.id}
              href={`/characters/${c.id}/pop`}
              className="rounded-md border border-border px-2.5 py-1 font-medium text-emerald-400 hover:border-emerald-700 hover:text-emerald-300"
            >
              {c.name}
            </Link>
          ))}
        </div>
      )}
      <PopProgressionView rows={rows} zoneCatalog={getZoneCatalog()} nowMs={Date.now()} />
    </div>
  );
}
