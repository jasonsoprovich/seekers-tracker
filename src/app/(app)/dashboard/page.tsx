import { eq, inArray } from "drizzle-orm";
import { redirect } from "next/navigation";

import { GuildLeadership } from "@/components/dashboard/GuildLeadership";
import { GuildPopMeter } from "@/components/dashboard/GuildPopMeter";
import { RosterOverview, type RosterEntry } from "@/components/dashboard/RosterOverview";
import { PageHeader } from "@/components/shell/PageHeader";
import { characterPopFlags, characters, players, users } from "@/db";
import { LEADERSHIP_ROLES } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { getStandings } from "@/lib/epgp/standings";
import { resolveFlags } from "@/lib/pop-flags";
import { getSession } from "@/lib/session";

type Character = typeof characters.$inferSelect;
type FlagRow = { flagId: string; done: boolean; source: "manual" | "seer" | "import" };

// Guild PoP progress — mules excluded (leader, 2026-09-05: "mules can be
// ignored"; they don't raid, so their PoP checklist is never meaningful).
// The status filter this used to also expose ("Active only" vs "Include
// inactive+removed") was a broken toggle — removed rather than fixed for
// now (leader, 2026-09-05); this always scopes to active-status characters,
// which was the default view anyway.
function aggregatePop(chars: Character[], flagsByCharacter: Map<number, FlagRow[]>) {
  let mainDone = 0;
  let mainTotal = 0;
  let allDone = 0;
  let allTotal = 0;
  for (const c of chars) {
    if (c.charType === "mule") continue;
    const resolved = resolveFlags(flagsByCharacter.get(c.id) ?? []);
    allDone += resolved.done;
    allTotal += resolved.total;
    if (c.charType === "main") {
      mainDone += resolved.done;
      mainTotal += resolved.total;
    }
  }
  return { mainDone, mainTotal, allDone, allTotal };
}

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const allCharacters = await db.select().from(characters);
  const standings = await getStandings(db);

  // Shared roster feed for RosterOverview's combined Characters/Mains/Alts
  // card, Roster-by-Class chart, and Active-by-Class list — one filter
  // (alts on/off, time window incl. "All time"), all three driven by it
  // (leader, 2026-09-05), rather than each having its own separate toggle.
  // Mules always excluded. `lastActivityMs` is null (never filtered out
  // under "All time", but excluded by every windowed option) rather than
  // dropped outright, per character.activity.ts's per-CHARACTER — not
  // per-player — activity (a roster entry never inherits a sibling's).
  const rosterEntries: RosterEntry[] = allCharacters
    .filter((c) => c.charType !== "mule" && c.playerId !== null && c.status === "active")
    .map((c) => ({
      name: c.name,
      classId: c.class,
      charType: c.charType === "main" ? "main" : "alt",
      priority: standings.get(c.playerId as number)?.priorityRating ?? 0,
      lastActivityMs: c.lastActivityAt?.getTime() ?? null,
    }));

  // Guild-wide table, not filtered by character ID list — an inArray() of
  // every character's ID hits D1's ~100-bound-parameter-per-statement limit
  // once the roster grows past that (surfaced by the roster seed, §9 task 20
  // follow-up). Reading the whole (small, guild-scale) table sidesteps it.
  const flagRows = await db.select().from(characterPopFlags);
  const flagsByCharacter = new Map<number, FlagRow[]>();
  for (const r of flagRows) {
    if (!flagsByCharacter.has(r.characterId)) flagsByCharacter.set(r.characterId, []);
    flagsByCharacter.get(r.characterId)!.push({ flagId: r.flagId, done: r.done, source: r.source });
  }

  const activeCharacters = allCharacters.filter((c) => c.status === "active");
  const pop = aggregatePop(activeCharacters, flagsByCharacter);

  // Guild leadership roster (leader request, 2026-09-05): who currently
  // holds leadership and officer, by their MAIN character only — an
  // officer's alts aren't "the officer roster." A user with a role but no
  // main character row yet (brand new, or one that predates character
  // claiming) simply doesn't get a row rather than showing a blank name.
  //
  // post-live-test-1 (LT-12): on THIS card the `admin` role lists under
  // Officers, not Leaders. Site-admin is a technical role, not a guild
  // leadership seat; the leader wants the Leaders column to be the in-game
  // guild leads only. (authz.ts LEADERSHIP_ROLES still governs permissions
  // everywhere else — this is display grouping for one dashboard card.)
  // Keyed by the ACCOUNT's main (players.user_id -> players.main_character_id),
  // not by a character's own claim link — same fix as the roster's role
  // column (2026-09-11).
  const roleHolders = await db
    .select({ username: users.username, role: users.role, mainCharacterName: characters.name })
    .from(users)
    .innerJoin(players, eq(players.userId, users.id))
    .innerJoin(characters, eq(characters.id, players.mainCharacterId))
    .where(inArray(users.role, [...LEADERSHIP_ROLES, "officer"]));
  const leadership = roleHolders.filter((r) => r.role === "leader");
  const officers = roleHolders.filter((r) => r.role === "officer" || r.role === "admin");

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Guild Dashboard" />
      <GuildLeadership leadership={leadership} officers={officers} />
      <div className="mt-4">
        <GuildPopMeter mainsOnly={{ done: pop.mainDone, total: pop.mainTotal }} all={{ done: pop.allDone, total: pop.allTotal }} />
      </div>
      <RosterOverview roster={rosterEntries} nowMs={Date.now()} />
    </div>
  );
}
