import { asc, eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { epgpInfoSections } from "@/db";
import { recordSystemEvent, webActor } from "@/lib/system-log";

export type InfoSection = typeof epgpInfoSections.$inferSelect;

// Cycle/Rules info page's free-text sections — see schema.ts's comment on
// epgp_info_sections for why these are separate from epgp_settings.
export async function listInfoSections(db: ReturnType<typeof drizzle>): Promise<InfoSection[]> {
  return db.select().from(epgpInfoSections).orderBy(asc(epgpInfoSections.sortOrder));
}

export async function updateInfoSection(
  db: ReturnType<typeof drizzle>,
  key: string,
  fields: { title: string; body: string },
  userId: string,
): Promise<void> {
  const [before] = await db.select({ title: epgpInfoSections.title, body: epgpInfoSections.body }).from(epgpInfoSections).where(eq(epgpInfoSections.key, key));
  await db
    .update(epgpInfoSections)
    .set({ title: fields.title, body: fields.body, updatedBy: userId, updatedAt: new Date() })
    .where(eq(epgpInfoSections.key, key));
  await recordSystemEvent(db, await webActor(db, userId), {
    action: "epgp.info.update",
    targetType: "info_section",
    targetId: key,
    targetLabel: fields.title,
    summary: `Rules info section "${key}" edited`,
    before,
    after: fields,
  });
}
