import { eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

import { characters } from "@/db";
import { getDb } from "@/lib/db";
import { charClassLabel, charRaceName } from "@/lib/eq/enums";
import { getSession } from "@/lib/session";

export default async function CharactersPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const rows = await db
    .select()
    .from(characters)
    .where(eq(characters.ownerId, session.user.id))
    .orderBy(characters.name);

  return (
    <div className="min-h-screen bg-neutral-950 px-6 py-10 text-neutral-100">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Your Characters</h1>
          <Link
            href="/characters/new"
            className="rounded-full bg-emerald-500 px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-emerald-400"
          >
            Add Character
          </Link>
        </div>

        {rows.length === 0 ? (
          <p className="mt-8 text-neutral-400">You haven&apos;t added any characters yet.</p>
        ) : (
          <ul className="mt-8 divide-y divide-neutral-800 rounded-lg border border-neutral-800">
            {rows.map((c) => (
              <li key={c.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="font-medium">
                    {c.name}{" "}
                    <span className="text-sm font-normal text-neutral-500">
                      {c.charType === "alt" ? "(Alt)" : "(Main)"}
                    </span>
                  </p>
                  <p className="text-sm text-neutral-400">
                    Level {c.level} {charClassLabel(c.class)} — {charRaceName(c.race)}
                  </p>
                </div>
                <Link
                  href={`/characters/${c.id}/edit`}
                  className="text-sm font-medium text-emerald-400 hover:text-emerald-300"
                >
                  Edit
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
