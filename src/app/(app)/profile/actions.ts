"use server";

import { eq } from "drizzle-orm";

import { users } from "@/db";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";

export type UpdateTimezoneResult = { error?: string };

// A user's own display-timezone preference — self-service, no role gate
// beyond "is signed in". See schema.ts's users.timezone comment for why
// this only affects display, never shared groupings like raid dates.
export async function updateTimezoneAction(timezone: string): Promise<UpdateTimezoneResult> {
  const session = await getSession();
  if (!session) return { error: "Not signed in." };

  const value = timezone.trim();
  if (value) {
    try {
      // Throws RangeError on an invalid IANA zone name — the cheapest
      // validation available without shipping a zone list to check against.
      new Intl.DateTimeFormat("en-US", { timeZone: value });
    } catch {
      return { error: `"${value}" isn't a recognized timezone.` };
    }
  }

  const db = await getDb();
  await db
    .update(users)
    .set({ timezone: value || null, updatedAt: new Date() })
    .where(eq(users.id, session.user.id));
  return {};
}
