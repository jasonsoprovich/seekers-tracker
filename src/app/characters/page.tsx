import { eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

import { characterPopFlags, characters } from "@/db";
import { canManageAnyCharacter, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { charClassLabel, charRaceName } from "@/lib/eq/enums";
import { resolveFlags } from "@/lib/pop-flags";
import { getSession } from "@/lib/session";

export default async function CharactersPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);

  const db = await getDb();
  const rows = await db
    .select()
    .from(characters)
    .where(eq(characters.ownerId, session.user.id))
    .orderBy(characters.name);

  const flagRows =
    rows.length === 0
      ? []
      : await db
          .select()
          .from(characterPopFlags)
          .where(inArray(characterPopFlags.characterId, rows.map((c) => c.id)));
  const flagsByCharacter = new Map<number, typeof flagRows>();
  for (const r of flagRows) {
    if (!flagsByCharacter.has(r.characterId)) flagsByCharacter.set(r.characterId, []);
    flagsByCharacter.get(r.characterId)!.push(r);
  }

  return (
    <div className="min-h-screen bg-neutral-950 px-6 py-10 text-neutral-100">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Your Characters</h1>
          <div className="flex items-center gap-3">
            <Link
              href="/dashboard"
              className="rounded-full border border-neutral-700 px-4 py-2 text-sm font-medium transition-colors hover:border-emerald-500 hover:text-emerald-400"
            >
              Dashboard
            </Link>
            {canManageAnyCharacter(role) && (
              <Link
                href="/admin"
                className="rounded-full border border-neutral-700 px-4 py-2 text-sm font-medium transition-colors hover:border-emerald-500 hover:text-emerald-400"
              >
                Admin
              </Link>
            )}
            <Link
              href="/characters/new"
              className="rounded-full bg-emerald-500 px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-emerald-400"
            >
              Add Character
            </Link>
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="mt-8 text-neutral-400">You haven&apos;t added any characters yet.</p>
        ) : (
          <ul className="mt-8 divide-y divide-neutral-800 rounded-lg border border-neutral-800">
            {rows.map((c) => {
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
                        {c.charType === "alt" ? "(Alt)" : "(Main)"}
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
                  <div className="flex shrink-0 items-center gap-4">
                    <Link
                      href={`/characters/${c.id}/import`}
                      className="text-sm font-medium text-emerald-400 hover:text-emerald-300"
                    >
                      Import Seer Text
                    </Link>
                    <Link
                      href={`/characters/${c.id}/edit`}
                      className="text-sm font-medium text-emerald-400 hover:text-emerald-300"
                    >
                      Edit
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
