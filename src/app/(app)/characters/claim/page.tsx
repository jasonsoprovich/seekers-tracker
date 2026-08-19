import { and, eq, isNull, ne } from "drizzle-orm";
import { redirect } from "next/navigation";

import { ClaimCharacterList } from "@/components/characters/ClaimCharacterList";
import { PageHeader } from "@/components/shell/PageHeader";
import { characterClaims, characters } from "@/db";
import { getDb } from "@/lib/db";
import { charClassLabel, charRaceName } from "@/lib/eq/enums";
import { getSession } from "@/lib/session";

export default async function ClaimCharacterPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const [unclaimed, myPending] = await Promise.all([
    db
      .select({
        id: characters.id,
        name: characters.name,
        classId: characters.class,
        raceId: characters.race,
        level: characters.level,
        charType: characters.charType,
      })
      .from(characters)
      .where(and(isNull(characters.ownerId), ne(characters.status, "removed")))
      .orderBy(characters.name),
    db
      .select({ characterId: characterClaims.characterId })
      .from(characterClaims)
      .where(and(eq(characterClaims.requesterId, session.user.id), eq(characterClaims.status, "pending"))),
  ]);

  const pendingIds = new Set(myPending.map((r) => r.characterId));

  const rows = unclaimed.map((c) => ({
    id: c.id,
    name: c.name,
    className: charClassLabel(c.classId),
    raceName: charRaceName(c.raceId),
    level: c.level,
    charType: c.charType,
    alreadyPending: pendingIds.has(c.id),
  }));

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        breadcrumbs={[{ label: "Characters", href: "/characters" }, { label: "Claim a Character" }]}
        title="Claim a Character"
        subtitle="Every unclaimed character imported from the guild's EPGP sheet. Claiming one sends a request to the officers for approval."
      />
      <ClaimCharacterList rows={rows} />
    </div>
  );
}
