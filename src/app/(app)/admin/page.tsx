import { eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

import { DeleteCharacterButton } from "@/components/DeleteCharacterButton";
import { RoleSelect } from "@/components/RoleSelect";
import { SyncEpgpButton } from "@/components/SyncEpgpButton";
import { PageHeader } from "@/components/shell/PageHeader";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { characterPopFlags, characters, users } from "@/db";
import { canManageAnyCharacter, canManageRoles, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { charClassLabel, charRaceName } from "@/lib/eq/enums";
import { resolveFlags } from "@/lib/pop-flags";
import { getSession } from "@/lib/session";

export default async function AdminPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);
  if (!canManageAnyCharacter(role)) redirect("/characters");

  const db = await getDb();

  const roster = await db
    .select({
      id: characters.id,
      name: characters.name,
      class: characters.class,
      race: characters.race,
      level: characters.level,
      charType: characters.charType,
      mainCharacterId: characters.mainCharacterId,
      ownerUsername: users.username,
      ownerId: characters.ownerId,
    })
    .from(characters)
    .innerJoin(users, eq(characters.ownerId, users.id))
    .orderBy(characters.name);

  const nameById = new Map(roster.map((c) => [c.id, c.name]));

  // Guild-wide table, not filtered by character ID list — see dashboard's
  // identical comment: an inArray() of every character's ID hits D1's
  // ~100-bound-parameter-per-statement limit once the roster grows past
  // that.
  const flagRows = await db.select().from(characterPopFlags);
  const flagsByCharacter = new Map<number, typeof flagRows>();
  for (const r of flagRows) {
    if (!flagsByCharacter.has(r.characterId)) flagsByCharacter.set(r.characterId, []);
    flagsByCharacter.get(r.characterId)!.push(r);
  }

  const canEditRoles = canManageRoles(role);
  const members = canEditRoles
    ? await db
        .select({
          id: users.id,
          username: users.username,
          role: users.role,
          discordVerified: users.discordVerified,
          createdAt: users.createdAt,
        })
        .from(users)
        .orderBy(users.username)
    : [];

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Admin"
        actions={
          <>
            <Link href="/admin/imports" className="text-emerald-400 hover:text-emerald-300">
              Import Audit Trail
            </Link>
            <SyncEpgpButton />
          </>
        }
      />

      <section>
        <h2 className="text-lg font-semibold">All Characters</h2>
        <p className="mt-1 text-sm text-neutral-400">
          As {role}, you can view, edit, and delete any member&apos;s character. Edit a character to change its
          main/alt status or link an alt to its main.
        </p>
        {roster.length === 0 ? (
          <p className="mt-4 text-neutral-400">No characters have been added yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
            {roster.map((c) => {
              const resolved = resolveFlags(
                (flagsByCharacter.get(c.id) ?? []).map((r) => ({
                  flagId: r.flagId,
                  done: r.done,
                  source: r.source,
                })),
              );
              return (
                <li key={c.id} className="flex items-center justify-between px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      <Link href={`/characters/${c.id}`} className="hover:text-emerald-400">
                        {c.name}
                      </Link>{" "}
                      <span className="text-sm font-normal text-neutral-500">
                        {c.charType === "alt" ? "(Alt)" : "(Main)"} — {c.ownerUsername}
                        {c.charType === "alt" && c.mainCharacterId && (
                          <> → {nameById.get(c.mainCharacterId) ?? "(unknown)"}</>
                        )}
                      </span>
                    </p>
                    <p className="text-sm text-neutral-400">
                      Level {c.level} {charClassLabel(c.class)} — {charRaceName(c.race)}
                    </p>
                    <div className="mt-1.5 w-32">
                      <ProgressBar done={resolved.done} total={resolved.total} suffix=" PoP" />
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-4">
                    <Link href={`/characters/${c.id}/edit`} className="text-sm font-medium text-emerald-400 hover:text-emerald-300">
                      Edit
                    </Link>
                    <DeleteCharacterButton characterId={c.id} characterName={c.name} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {canEditRoles && (
        <section className="mt-10">
          <h2 className="text-lg font-semibold">Members &amp; Roles</h2>
          <p className="mt-1 text-sm text-neutral-400">Promote or demote members. Only leaders can change roles.</p>
          <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
            {members.map((m) => (
              <li key={m.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="font-medium">{m.username ?? "(no username)"}</p>
                  <p className="text-sm text-neutral-500">
                    {m.discordVerified ? "Discord verified" : "Not Discord-verified"} · joined{" "}
                    {m.createdAt.toLocaleDateString()}
                  </p>
                </div>
                <RoleSelect userId={m.id} role={m.role} isSelf={m.id === session.user.id} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
