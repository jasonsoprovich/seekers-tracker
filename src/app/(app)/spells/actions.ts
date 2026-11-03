"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { spellSettings } from "@/db";
import { getDb } from "@/lib/db";
import { getPermissions } from "@/lib/permissions";
import { getSession } from "@/lib/session";
import { getSpell } from "@/lib/spells";
import { recordSpellHideEvent } from "@/lib/system-log/spells";

export async function setSpellHidden(spellId: number, hidden: boolean): Promise<{ error?: string }> {
  const session = await getSession();
  if (!session) redirect("/login");

  const perms = await getPermissions(session.user.id);
  if (!perms.can("spells.manage")) return { error: "You don't have permission to hide spells." };

  const spell = getSpell(spellId);
  if (!spell) return { error: "Unknown spell." };

  const db = await getDb();
  const now = new Date();
  await db
    .insert(spellSettings)
    .values({ spellId, hidden, updatedBy: session.user.id, updatedAt: now })
    .onConflictDoUpdate({ target: spellSettings.spellId, set: { hidden, updatedBy: session.user.id, updatedAt: now } });
  await recordSpellHideEvent(db, session.user.id, spell, hidden);

  revalidatePath("/spells");
  return {};
}
