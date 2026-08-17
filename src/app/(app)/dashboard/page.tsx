import { redirect } from "next/navigation";

import { ClassBarChart, type ClassCompositionRow } from "@/components/dashboard/ClassBarChart";
import { ClassPopChart, type ClassPopRow } from "@/components/dashboard/ClassPopChart";
import { GuildPopMeter } from "@/components/dashboard/GuildPopMeter";
import { LevelBarChart, type LevelBracketRow } from "@/components/dashboard/LevelBarChart";
import { StatTile } from "@/components/dashboard/StatTile";
import { PageHeader } from "@/components/shell/PageHeader";
import { Card } from "@/components/ui/Card";
import { characterPopFlags, characters } from "@/db";
import { CHAR_CLASSES, LEVEL_BRACKETS, levelBracket } from "@/lib/eq/enums";
import { resolveFlags } from "@/lib/pop-flags";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const allCharacters = await db.select().from(characters);

  // Guild-wide table, not filtered by character ID list — an inArray() of
  // every character's ID hits D1's ~100-bound-parameter-per-statement limit
  // once the roster grows past that (surfaced by the roster seed, §9 task 20
  // follow-up). Reading the whole (small, guild-scale) table sidesteps it.
  const flagRows = await db.select().from(characterPopFlags);
  const flagsByCharacter = new Map<number, typeof flagRows>();
  for (const r of flagRows) {
    if (!flagsByCharacter.has(r.characterId)) flagsByCharacter.set(r.characterId, []);
    flagsByCharacter.get(r.characterId)!.push(r);
  }

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

  for (const c of allCharacters) {
    const rows = flagsByCharacter.get(c.id) ?? [];
    const resolved = resolveFlags(rows.map((r) => ({ flagId: r.flagId, done: r.done, source: r.source })));

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

  const classRows: ClassCompositionRow[] = CHAR_CLASSES.map((cl) => ({
    id: cl.id,
    abbr: cl.abbr,
    ...(byClass.get(cl.id) ?? { main: 0, alt: 0 }),
  }));
  const bracketRows: LevelBracketRow[] = LEVEL_BRACKETS.map((label) => ({
    label,
    count: byBracket.get(label) ?? 0,
  }));
  const classPopRows: ClassPopRow[] = CHAR_CLASSES.map((cl) => ({
    id: cl.id,
    abbr: cl.abbr,
    mainsOnly: byClassPopMains.get(cl.id) ?? { done: 0, total: 0 },
    all: byClassPopAll.get(cl.id) ?? { done: 0, total: 0 },
  }));

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Guild Dashboard" />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <StatTile label="Characters" value={allCharacters.length} />
        <StatTile label="Mains" value={mains} />
        <StatTile label="Alts" value={alts} />
        <div className="col-span-2 sm:col-span-3 lg:col-span-1">
          <GuildPopMeter mainsOnly={{ done: mainDone, total: mainTotal }} all={{ done: allDone, total: allTotal }} />
        </div>
      </div>

      <Card className="mt-4 p-4">
        <h2 className="text-lg font-semibold">Roster by Class</h2>
        <p className="mt-1 text-sm text-neutral-400">Every class shown, even at zero — that&apos;s the gap.</p>
        <div className="mt-4">
          <ClassBarChart rows={classRows} />
        </div>
      </Card>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="text-lg font-semibold">Roster by Level</h2>
          <p className="mt-1 text-sm text-neutral-400">Share of the guild in each level bracket.</p>
          <div className="mt-4">
            <LevelBarChart rows={bracketRows} />
          </div>
        </Card>

        <Card className="p-4">
          <h2 className="text-lg font-semibold">PoP Progress by Class</h2>
          <p className="mt-1 text-sm text-neutral-400">Non-optional flags complete, per class.</p>
          <div className="mt-4">
            <ClassPopChart rows={classPopRows} />
          </div>
        </Card>
      </div>
    </div>
  );
}
