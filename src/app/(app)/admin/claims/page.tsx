import { desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

import { ClaimReviewButtons } from "@/components/admin/ClaimReviewButtons";
import { PageHeader } from "@/components/shell/PageHeader";
import { characterClaims, characters, users } from "@/db";
import { canManageAnyCharacter, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { charClassLabel } from "@/lib/eq/enums";
import { getSession } from "@/lib/session";
import { guildDateTime } from "@/lib/guild-timezone";

const CHAR_TYPE_LABEL: Record<string, string> = { main: "Main", alt: "Alt", mule: "Mule" };

const STATUS_LABELS: Record<string, string> = {
  approved: "Approved",
  denied: "Denied",
};

export default async function ClaimReviewPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);
  if (!canManageAnyCharacter(role)) redirect("/characters");

  const db = await getDb();

  const rows = await db
    .select({
      id: characterClaims.id,
      status: characterClaims.status,
      note: characterClaims.note,
      decisionNote: characterClaims.decisionNote,
      createdAt: characterClaims.createdAt,
      characterId: characters.id,
      characterName: characters.name,
      characterClass: characters.class,
      characterLevel: characters.level,
      characterOwnerId: characters.ownerId,
      characterPlayerId: characters.playerId,
      requesterId: characterClaims.requesterId,
      requesterUsername: users.username,
    })
    .from(characterClaims)
    .innerJoin(characters, eq(characterClaims.characterId, characters.id))
    .innerJoin(users, eq(characterClaims.requesterId, users.id))
    .orderBy(desc(characterClaims.createdAt))
    .limit(200);

  const pending = rows.filter((r) => r.status === "pending");
  const decided = rows.filter((r) => r.status !== "pending");

  // Remediation plan Phase 5 task 5.3 — "show the complete main/alt/mule
  // group" to the officer before they approve, since approving attaches
  // all of it, not just the one character requested.
  const groupPlayerIds = [...new Set(pending.map((r) => r.characterPlayerId).filter((id): id is number => id != null))];
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

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        breadcrumbs={[{ label: "Admin", href: "/admin" }, { label: "Claim Requests" }]}
        title="Claim Requests"
        subtitle="Members requesting to attach an unclaimed roster character to their account."
      />

      <section>
        <h2 className="text-lg font-semibold">Pending ({pending.length})</h2>
        {pending.length === 0 ? (
          <p className="mt-2 text-neutral-400">No pending claims.</p>
        ) : (
          <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
            {pending.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    <Link href={`/characters/${r.characterId}`} className="hover:text-emerald-400">
                      {r.characterName}
                    </Link>{" "}
                    <span className="text-sm font-normal text-neutral-500">
                      Level {r.characterLevel} {charClassLabel(r.characterClass)} — requested by {r.requesterUsername ?? "(no username)"}
                    </span>
                  </p>
                  {r.note && <p className="mt-0.5 text-sm text-neutral-400">&ldquo;{r.note}&rdquo;</p>}
                  {r.characterOwnerId === r.requesterId && (
                    <p className="mt-0.5 text-xs text-amber-400">
                      Already assigned to this member — approving just clears the request.
                    </p>
                  )}
                  {(() => {
                    const siblings = (r.characterPlayerId != null ? groupsByPlayerId.get(r.characterPlayerId) ?? [] : []).filter(
                      (m) => m.id !== r.characterId,
                    );
                    return siblings.length > 0 ? (
                      <p className="mt-0.5 text-xs text-neutral-500">
                        Approving also attaches {siblings.map((m) => `${m.name} (${CHAR_TYPE_LABEL[m.charType] ?? m.charType})`).join(", ")}
                      </p>
                    ) : null;
                  })()}
                  <p className="mt-0.5 text-xs text-neutral-500 tabular-nums">
                    {guildDateTime(r.createdAt)}
                  </p>
                </div>
                <ClaimReviewButtons claimId={r.id} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {decided.length > 0 && (
        <section className="mt-10">
          <h2 className="text-lg font-semibold">Recently decided</h2>
          <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
            {decided.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    <Link href={`/characters/${r.characterId}`} className="hover:text-emerald-400">
                      {r.characterName}
                    </Link>{" "}
                    <span className="text-sm font-normal text-neutral-500">requested by {r.requesterUsername ?? "(no username)"}</span>
                  </p>
                  {r.decisionNote && <p className="mt-0.5 text-sm text-neutral-400">{r.decisionNote}</p>}
                </div>
                <span
                  className={`shrink-0 text-sm font-medium ${r.status === "approved" ? "text-emerald-400" : "text-red-400"}`}
                >
                  {STATUS_LABELS[r.status] ?? r.status}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
