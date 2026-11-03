import type { drizzle } from "drizzle-orm/d1";

import { webActor } from "./actor";
import { recordSystemEvent } from "./index";

type Db = ReturnType<typeof drizzle>;

// Same attribution rule as recordPopFlagEvent: tag whose character it was,
// so an officer checking spells off for a member stands out in the log.
export async function recordSpellEvent(
  db: Db,
  userId: string,
  character: { id: number; name: string; ownerId: string | null },
  action: "spells.toggle" | "spells.import",
  summary: string,
  after: Record<string, unknown>,
): Promise<void> {
  const ownership =
    character.ownerId === null ? "unclaimed" : character.ownerId === userId ? "own" : "other_member";
  const suffix =
    ownership === "unclaimed" ? " (unclaimed character)" : ownership === "other_member" ? " (another member's character)" : "";
  await recordSystemEvent(db, await webActor(db, userId), {
    action,
    targetType: "character",
    targetId: character.id,
    targetLabel: character.name,
    summary: `${character.name}: ${summary}${suffix}`,
    after: { ...after, ownership },
  });
}

export async function recordSpellHideEvent(
  db: Db,
  userId: string,
  spell: { spellId: number; name: string },
  hidden: boolean,
): Promise<void> {
  await recordSystemEvent(db, await webActor(db, userId), {
    action: "spells.hide",
    targetType: "spell",
    targetId: spell.spellId,
    targetLabel: spell.name,
    summary: `${spell.name} ${hidden ? "hidden" : "shown"} on /spells`,
    after: { hidden },
  });
}
