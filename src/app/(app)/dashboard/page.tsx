import { inArray } from "drizzle-orm";
import { redirect } from "next/navigation";

import { ClassCompositionChart, type ClassCompositionRow } from "@/components/dashboard/ClassCompositionChart";
import { ClassPopChart, type ClassPopRow } from "@/components/dashboard/ClassPopChart";
import { GuildPopMeter } from "@/components/dashboard/GuildPopMeter";
import { LevelBracketChart, type LevelBracketRow } from "@/components/dashboard/LevelBracketChart";
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

  const flagRows =
    allCharacters.length === 0
      ? []
      : await db
          .select()
          .from(characterPopFlags)
          .where(
            inArray(
              characterPopFlags.characterId,
              allCharacters.map((c) => c.id),
            ),
          );
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
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Guild Dashboard" />

      <div className="grid grid-cols-3 gap-3">
        <StatTile label="Characters" value={allCharacters.length} />
        <StatTile label="Mains" value={mains} />
        <StatTile label="Alts" value={alts} />
      </div>

      <div className="mt-4">
        <GuildPopMeter mainsOnly={{ done: mainDone, total: mainTotal }} all={{ done: allDone, total: allTotal }} />
      </div>

      <section className="mt-8">
        <h2 className="text-lg font-semibold">Roster by Class</h2>
        <p className="mt-1 text-sm text-neutral-400">Every class shown, even at zero — that&apos;s the gap.</p>
        <Card className="mt-4 p-4">
          <ClassCompositionChart rows={classRows} />
        </Card>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold">PoP Progress by Class</h2>
        <p className="mt-1 text-sm text-neutral-400">Non-optional flags complete, per class.</p>
        <Card className="mt-4 p-4">
          <ClassPopChart rows={classPopRows} />
        </Card>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold">Roster by Level</h2>
        <Card className="mt-4 p-4">
          <LevelBracketChart rows={bracketRows} />
        </Card>
      </section>
    </div>
  );
}
