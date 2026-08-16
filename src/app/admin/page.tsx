import { eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

import { RoleSelect } from "@/components/RoleSelect";
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
      ownerUsername: users.username,
      ownerId: characters.ownerId,
    })
    .from(characters)
    .innerJoin(users, eq(characters.ownerId, users.id))
    .orderBy(characters.name);

  const flagRows =
    roster.length === 0
      ? []
      : await db
          .select()
          .from(characterPopFlags)
          .where(
            inArray(
              characterPopFlags.characterId,
              roster.map((c) => c.id),
            ),
          );
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
    <div className="min-h-screen bg-neutral-950 px-6 py-10 text-neutral-100">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Admin</h1>
          <Link href="/characters" className="text-sm font-medium text-neutral-400 hover:text-neutral-300">
            Back
          </Link>
        </div>

        <section className="mt-8">
          <h2 className="text-lg font-semibold">All Characters</h2>
          <p className="mt-1 text-sm text-neutral-400">
            As {role}, you can view and edit any member&apos;s character.
          </p>
          {roster.length === 0 ? (
            <p className="mt-4 text-neutral-400">No characters have been added yet.</p>
          ) : (
            <ul className="mt-4 divide-y divide-neutral-800 rounded-lg border border-neutral-800">
              {roster.map((c) => {
                const resolved = resolveFlags(
                  (flagsByCharacter.get(c.id) ?? []).map((r) => ({
                    flagId: r.flagId,
                    done: r.done,
                    source: r.source,
                  })),
                );
                const complete = resolved.done === resolved.total && resolved.total > 0;
                return (
                  <li key={c.id} className="flex items-center justify-between px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">
                        <Link href={`/characters/${c.id}`} className="hover:text-emerald-400">
                          {c.name}
                        </Link>{" "}
                        <span className="text-sm font-normal text-neutral-500">
                          {c.charType === "alt" ? "(Alt)" : "(Main)"} — {c.ownerUsername}
                        </span>
                      </p>
                      <p className="text-sm text-neutral-400">
                        Level {c.level} {charClassLabel(c.class)} — {charRaceName(c.race)}
                      </p>
                      <div className="mt-1.5 flex items-center gap-2">
                        <div className="h-1.5 w-32 overflow-hidden rounded-full bg-neutral-800">
                          <div
                            className={`h-full rounded-full ${complete ? "bg-emerald-500" : "bg-sky-500"}`}
                            style={{
                              width: `${resolved.total === 0 ? 0 : Math.round((resolved.done / resolved.total) * 100)}%`,
                            }}
                          />
                        </div>
                        <span className="text-[11px] text-neutral-500 tabular-nums">
                          {resolved.done} / {resolved.total} PoP
                        </span>
                      </div>
                    </div>
                    <Link
                      href={`/characters/${c.id}/edit`}
                      className="shrink-0 text-sm font-medium text-emerald-400 hover:text-emerald-300"
                    >
                      Edit
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {canEditRoles && (
          <section className="mt-10">
            <h2 className="text-lg font-semibold">Members &amp; Roles</h2>
            <p className="mt-1 text-sm text-neutral-400">
              Promote or demote members. Only leaders can change roles.
            </p>
            <ul className="mt-4 divide-y divide-neutral-800 rounded-lg border border-neutral-800">
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
    </div>
  );
}
