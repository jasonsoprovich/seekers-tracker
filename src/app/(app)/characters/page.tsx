import { and, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/shell/PageHeader";
import { LinkButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { characterClaims, characterPopFlags, characters } from "@/db";
import { hasAnyLeader } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { charClassLabel, charRaceName } from "@/lib/eq/enums";
import { resolveFlags } from "@/lib/pop-flags";
import { getSession } from "@/lib/session";

export default async function CharactersPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const showBootstrapBanner = !(await hasAnyLeader());

  const db = await getDb();
  const [rows, pendingClaims] = await Promise.all([
    db
      .select()
      .from(characters)
      .where(eq(characters.ownerId, session.user.id))
      .orderBy(characters.name),
    db
      .select({ characterName: characters.name, note: characterClaims.note, createdAt: characterClaims.createdAt })
      .from(characterClaims)
      .innerJoin(characters, eq(characterClaims.characterId, characters.id))
      .where(and(eq(characterClaims.requesterId, session.user.id), eq(characterClaims.status, "pending")))
      .orderBy(characterClaims.createdAt),
  ]);

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
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Your Characters"
        actions={
          <>
            <LinkButton href="/characters/claim" variant="outline">
              Claim a Character
            </LinkButton>
            <LinkButton href="/characters/new" variant="primary" size="md">
              Add Character
            </LinkButton>
          </>
        }
      />

      {pendingClaims.length > 0 && (
        <Card className="mb-6 border-neutral-700 bg-neutral-900/40 px-4 py-3">
          <p className="text-sm font-medium text-neutral-200">
            {pendingClaims.length === 1 ? "1 pending claim" : `${pendingClaims.length} pending claims`} awaiting officer review
          </p>
          <ul className="mt-1.5 text-sm text-neutral-400">
            {pendingClaims.map((c) => (
              <li key={c.characterName}>{c.characterName}</li>
            ))}
          </ul>
        </Card>
      )}

      {showBootstrapBanner && (
        <Card className="mb-6 flex items-center justify-between gap-4 border-emerald-800 bg-emerald-950/40 px-4 py-3">
          <p className="text-sm text-emerald-200">
            Seekers of Souls doesn&apos;t have a leader yet — the first person here can claim it.
          </p>
          <LinkButton href="/bootstrap-leader" variant="primary" size="sm" className="shrink-0">
            Claim Leader Role
          </LinkButton>
        </Card>
      )}

      {rows.length === 0 ? (
        <p className="mt-8 text-neutral-400">You haven&apos;t added any characters yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {rows.map((c) => {
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
                      {c.charType === "alt" ? "(Alt)" : "(Main)"}
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
                  <Link
                    href={`/characters/${c.id}/import`}
                    className="text-sm font-medium text-emerald-400 hover:text-emerald-300"
                  >
                    Import
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
  );
}
