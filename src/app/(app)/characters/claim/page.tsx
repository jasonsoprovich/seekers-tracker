import { and, eq, inArray, isNull, ne } from "drizzle-orm";
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
        playerId: characters.playerId,
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

  // Remediation plan Phase 5 task 5.3 — "show the complete main/alt/mule
  // group" before a member picks one, since approving any one of them
  // claims the whole group (including members not in the unclaimed list
  // above, if any are already owned elsewhere). One batched query rather
  // than one per row.
  const groupPlayerIds = [...new Set(unclaimed.map((c) => c.playerId).filter((id): id is number => id != null))];
  const groupMembers =
    groupPlayerIds.length === 0
      ? []
      : await db
          .select({ id: characters.id, name: characters.name, charType: characters.charType, playerId: characters.playerId })
          .from(characters)
          .where(inArray(characters.playerId, groupPlayerIds));
  const groupsByPlayerId = new Map<number, typeof groupMembers>();
  for (const m of groupMembers) {
    if (m.playerId == null) continue;
    if (!groupsByPlayerId.has(m.playerId)) groupsByPlayerId.set(m.playerId, []);
    groupsByPlayerId.get(m.playerId)!.push(m);
  }

  const rows = unclaimed.map((c) => ({
    id: c.id,
    name: c.name,
    className: charClassLabel(c.classId),
    raceName: charRaceName(c.raceId),
    level: c.level,
    charType: c.charType,
    alreadyPending: pendingIds.has(c.id),
    groupMembers: (c.playerId != null ? groupsByPlayerId.get(c.playerId) ?? [] : [])
      .filter((m) => m.id !== c.id)
      .map((m) => ({ name: m.name, charType: m.charType })),
  }));

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        breadcrumbs={[{ label: "Characters", href: "/characters" }, { label: "Claim a Character" }]}
        title="Claim a Character"
        subtitle="Every unclaimed character imported from the guild's EPGP sheet. Claiming one sends a request to the officers to approve the complete main/alt/mule account."
      />
      <ClaimCharacterList rows={rows} />
    </div>
  );
}
