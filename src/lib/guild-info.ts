import { asc, eq, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { drizzle } from "drizzle-orm/d1";

import { guildInfoCards } from "@/db";
import { recordSystemEvent, webActor } from "@/lib/system-log";

type Db = ReturnType<typeof drizzle>;
export type GuildInfoCard = typeof guildInfoCards.$inferSelect;
export type CardWidth = "full" | "half";

export const GUILD_INFO_LIMITS = { title: 120, body: 20_000 } as const;

export async function listGuildInfoCards(db: Db): Promise<GuildInfoCard[]> {
  return db.select().from(guildInfoCards).orderBy(asc(guildInfoCards.sortOrder), asc(guildInfoCards.id));
}

function validate(title: string, body: string): string | null {
  if (!title.trim()) return "Title is required.";
  if (title.trim().length > GUILD_INFO_LIMITS.title) return `Title must be ${GUILD_INFO_LIMITS.title} characters or fewer.`;
  if (body.length > GUILD_INFO_LIMITS.body) return `Text must be ${GUILD_INFO_LIMITS.body.toLocaleString()} characters or fewer.`;
  return null;
}

async function audit(db: Db, userId: string, action: "guild.info.create" | "guild.info.update" | "guild.info.reorder" | "guild.info.delete", card: { id: number; title: string }, summary: string, before?: unknown, after?: unknown) {
  await recordSystemEvent(db, await webActor(db, userId), {
    action,
    targetType: "guild_info_card",
    targetId: String(card.id),
    targetLabel: card.title,
    summary,
    before,
    after,
  });
}

export async function createGuildInfoCard(
  db: Db,
  fields: { title: string; body: string; width: CardWidth },
  userId: string,
): Promise<{ error: string } | { id: number }> {
  const err = validate(fields.title, fields.body);
  if (err) return { error: err };
  const [{ next }] = await db.select({ next: sql<number>`coalesce(max(${guildInfoCards.sortOrder}), 0) + 1` }).from(guildInfoCards);
  const [row] = await db
    .insert(guildInfoCards)
    .values({ title: fields.title.trim(), body: fields.body, width: fields.width, sortOrder: next, createdBy: userId, updatedBy: userId })
    .returning();
  await audit(db, userId, "guild.info.create", row, `Guild info card "${row.title}" created`, undefined, row);
  return { id: row.id };
}

export async function updateGuildInfoCard(
  db: Db,
  id: number,
  fields: { title: string; body: string },
  userId: string,
): Promise<{ error?: string }> {
  const err = validate(fields.title, fields.body);
  if (err) return { error: err };
  const [before] = await db.select().from(guildInfoCards).where(eq(guildInfoCards.id, id));
  if (!before) return { error: "Card not found." };
  const [after] = await db
    .update(guildInfoCards)
    .set({ title: fields.title.trim(), body: fields.body, updatedBy: userId, updatedAt: new Date() })
    .where(eq(guildInfoCards.id, id))
    .returning();
  await audit(db, userId, "guild.info.update", after, `Guild info card "${after.title}" edited`, before, after);
  return {};
}

export async function setGuildInfoCardWidth(db: Db, id: number, width: CardWidth, userId: string): Promise<{ error?: string }> {
  const [before] = await db.select().from(guildInfoCards).where(eq(guildInfoCards.id, id));
  if (!before) return { error: "Card not found." };
  await db.update(guildInfoCards).set({ width, updatedBy: userId, updatedAt: new Date() }).where(eq(guildInfoCards.id, id));
  await audit(db, userId, "guild.info.update", before, `Guild info card "${before.title}" set to ${width} width`, { width: before.width }, { width });
  return {};
}

// Swaps sort_order with the neighbouring card. Normalises the whole list to
// 1..n first, so duplicate/gappy sort_order values can never make a move a
// no-op.
export async function moveGuildInfoCard(db: Db, id: number, direction: "up" | "down", userId: string): Promise<{ error?: string }> {
  const cards = await listGuildInfoCards(db);
  const i = cards.findIndex((c) => c.id === id);
  if (i < 0) return { error: "Card not found." };
  const j = direction === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= cards.length) return {};
  const order = cards.map((c) => c.id);
  [order[i], order[j]] = [order[j], order[i]];
  const stmts: BatchItem<"sqlite">[] = order.map((cardId, idx) =>
    db.update(guildInfoCards).set({ sortOrder: idx + 1 }).where(eq(guildInfoCards.id, cardId)),
  );
  await db.batch(stmts as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  await audit(db, userId, "guild.info.reorder", cards[i], `Guild info card "${cards[i].title}" moved ${direction}`);
  return {};
}

export async function deleteGuildInfoCard(db: Db, id: number, userId: string): Promise<{ error?: string }> {
  const [before] = await db.select().from(guildInfoCards).where(eq(guildInfoCards.id, id));
  if (!before) return { error: "Card not found." };
  await db.delete(guildInfoCards).where(eq(guildInfoCards.id, id));
  await audit(db, userId, "guild.info.delete", before, `Guild info card "${before.title}" deleted`, before);
  return {};
}
