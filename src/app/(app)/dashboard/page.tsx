import { redirect } from "next/navigation";

import { ActiveByClass, type ActiveRosterEntry } from "@/components/dashboard/ActiveByClass";
import { DashboardBody, type DashboardBundle } from "@/components/dashboard/DashboardBody";
import { PageHeader } from "@/components/shell/PageHeader";
import { characterPopFlags, characters } from "@/db";
import { CHAR_CLASSES, LEVEL_BRACKETS, levelBracket } from "@/lib/eq/enums";
import { getStandings } from "@/lib/epgp/standings";
import { resolveFlags } from "@/lib/pop-flags";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";

type Character = typeof characters.$inferSelect;
type FlagRow = { flagId: string; done: boolean; source: "manual" | "seer" | "import" };

// Both dashboard scopes ("active only" vs "include inactive+removed") run
// this same aggregation, once each — see DashboardBody's comment for why
// that's precomputed server-side rather than filtered client-side.
function aggregate(chars: Character[], flagsByCharacter: Map<number, FlagRow[]>): DashboardBundle {
  let mains = 0;
  let alts = 0;
  let mainDone = 0;
  let mainTotal = 0;
  let allDone = 0;
  let allTotal = 0;
  const byClass = new Map<number, { main: number; alt: number }>();
  const byBracket = new Map<string, number>();
  const byClassPopMains = new Map<number, { done: number; total: number }>();
  const byClassPopAll = new Map<number, { done: number; total: number }>();

  for (const c of chars) {
    const resolved = resolveFlags(flagsByCharacter.get(c.id) ?? []);

    allDone += resolved.done;
    allTotal += resolved.total;
    if (c.charType === "main") {
      mains++;
      mainDone += resolved.done;
      mainTotal += resolved.total;
    } else {
      alts++;
    }

    const cls = byClass.get(c.class) ?? { main: 0, alt: 0 };
    if (c.charType === "main") cls.main++;
    else cls.alt++;
    byClass.set(c.class, cls);

    const clsPopAll = byClassPopAll.get(c.class) ?? { done: 0, total: 0 };
    clsPopAll.done += resolved.done;
    clsPopAll.total += resolved.total;
    byClassPopAll.set(c.class, clsPopAll);
    if (c.charType === "main") {
      const clsPopMains = byClassPopMains.get(c.class) ?? { done: 0, total: 0 };
      clsPopMains.done += resolved.done;
      clsPopMains.total += resolved.total;
      byClassPopMains.set(c.class, clsPopMains);
    }

    const bracket = levelBracket(c.level);
    byBracket.set(bracket, (byBracket.get(bracket) ?? 0) + 1);
  }

  return {
    characterCount: chars.length,
    mains,
    alts,
    mainDone,
    mainTotal,
    allDone,
    allTotal,
    classRows: CHAR_CLASSES.map((cl) => ({ id: cl.id, abbr: cl.abbr, ...(byClass.get(cl.id) ?? { main: 0, alt: 0 }) })),
    bracketRows: LEVEL_BRACKETS.map((label) => ({ label, count: byBracket.get(label) ?? 0 })),
    classPopRows: CHAR_CLASSES.map((cl) => ({
      id: cl.id,
      abbr: cl.abbr,
      mainsOnly: byClassPopMains.get(cl.id) ?? { done: 0, total: 0 },
      all: byClassPopAll.get(cl.id) ?? { done: 0, total: 0 },
    })),
  };
}

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const allCharacters = await db.select().from(characters);
  const standings = await getStandings(db);

  // "Active Members by Class" board: every non-mule character whose player
  // has any EP/GP ledger activity, with the player's shared Loot Priority
  // and last-activity timestamp. The window filter (24h/7d/1mo/1yr) is
  // applied client-side. Character `status` isn't filtered here — recency
  // is the point of the view.
  const activeRoster: ActiveRosterEntry[] = allCharacters
    .filter((c) => c.charType !== "mule" && c.playerId !== null)
    .map((c): ActiveRosterEntry | null => {
      const s = standings.get(c.playerId as number);
      if (!s?.lastActivityAt) return null;
      return {
        name: c.name,
        classId: c.class,
        isAlt: c.charType === "alt",
        priority: s.priorityRating,
        lastActivityMs: s.lastActivityAt.getTime(),
      };
    })
    .filter((e): e is ActiveRosterEntry => e !== null);

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

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Guild Dashboard" />
      <DashboardBody all={aggregate(allCharacters, flagsByCharacter)} activeOnly={aggregate(activeCharacters, flagsByCharacter)} />
      <ActiveByClass roster={activeRoster} nowMs={Date.now()} />
    </div>
  );
}
