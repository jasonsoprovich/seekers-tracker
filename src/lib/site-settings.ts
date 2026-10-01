import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";
import { cache } from "react";

import { siteSettings } from "@/db";
import { getDb } from "@/lib/db";
import { recordSystemEvent, webActor } from "@/lib/system-log";

type Db = ReturnType<typeof drizzle>;

// Admin-only feature flags (src/app/(app)/admin → "Site features"). Distinct
// from epgp_settings, which is effective-dated guild policy: these are plain
// on/off switches with no history needed (changes are audited in the system
// log).
export const SITE_SETTING_KEYS = ["item_tooltips"] as const;
export type SiteSettingKey = (typeof SITE_SETTING_KEYS)[number];

// Item tooltips ship OFF until an admin turns them on.
const DEFAULTS: Record<SiteSettingKey, string> = { item_tooltips: "off" };

export async function getSiteSetting(db: Db, key: SiteSettingKey): Promise<string> {
  const [row] = await db.select({ value: siteSettings.value }).from(siteSettings).where(eq(siteSettings.key, key));
  return row?.value ?? DEFAULTS[key];
}

export async function setSiteSetting(db: Db, key: SiteSettingKey, value: string, userId: string): Promise<void> {
  const before = await getSiteSetting(db, key);
  await db
    .insert(siteSettings)
    .values({ key, value, updatedBy: userId })
    .onConflictDoUpdate({ target: siteSettings.key, set: { value, updatedBy: userId, updatedAt: new Date() } });
  await recordSystemEvent(db, await webActor(db, userId), {
    action: "system.setting.change",
    targetType: "site_setting",
    targetId: key,
    targetLabel: key,
    summary: `Site setting "${key}" set to ${value}`,
    before: { value: before },
    after: { value },
  });
}

// Read once per request (layout + any page/route share the result).
export const itemTooltipsEnabled = cache(async (): Promise<boolean> => {
  try {
    return (await getSiteSetting(await getDb(), "item_tooltips")) === "on";
  } catch {
    // The flag is cosmetic — never take a page down because it couldn't be read.
    return false;
  }
});
