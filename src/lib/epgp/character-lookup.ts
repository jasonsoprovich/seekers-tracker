import { sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { characters } from "@/db";

// characters.name only has COLLATE NOCASE on its unique index (see
// src/db/schema.ts), not the column itself, so a plain eq() comparison
// here would be case-sensitive — explicit COLLATE NOCASE in the WHERE
// clause matches what that index already guarantees is unambiguous. Used
// by the officer attendance/bid routes, which match free-text names off
// EQ log lines (/who guild, tells) rather than a characterId the caller
// already knows.
export async function findCharacterIdByName(db: ReturnType<typeof drizzle>, rawName: string): Promise<number | null> {
  const name = rawName.trim();
  if (!name) return null;
  const [row] = await db
    .select({ id: characters.id })
    .from(characters)
    .where(sql`${characters.name} = ${name} COLLATE NOCASE`);
  return row?.id ?? null;
}
