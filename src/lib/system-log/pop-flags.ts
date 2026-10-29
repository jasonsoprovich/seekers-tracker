import type { drizzle } from "drizzle-orm/d1";

import { webActor } from "./actor";
import { recordSystemEvent } from "./index";

type Db = ReturnType<typeof drizzle>;

// PoP flag edits had no attribution at all (character_pop_flags has no
// updated_by) — 2026-10-29, eight unclaimed characters turned up with
// hand-ticked flags and nobody could say who did it. Every checklist click
// and flag import now leaves a "flags" row in the System Log, tagged with
// whose character it was so edits made for someone else stand out.
export async function recordPopFlagEvent(
  db: Db,
  userId: string,
  character: { id: number; name: string; ownerId: string | null },
  action: "flags.toggle" | "flags.import",
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
