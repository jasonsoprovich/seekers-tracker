import { and, eq, gt, inArray } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { epLedger, gpLedger, players } from "@/db";

export const ACTIVITY_WINDOWS = [
  { key: "24h", label: "24 hours", milliseconds: 24 * 60 * 60 * 1000 },
  { key: "7d", label: "7 days", milliseconds: 7 * 24 * 60 * 60 * 1000 },
  { key: "30d", label: "30 days", milliseconds: 30 * 24 * 60 * 60 * 1000 },
  { key: "365d", label: "365 days", milliseconds: 365 * 24 * 60 * 60 * 1000 },
  { key: "all", label: "All time", milliseconds: null },
] as const;

export type ActivityWindowKey = (typeof ACTIVITY_WINDOWS)[number]["key"];
export type AccountActivitySummary = {
  playerId: number;
  displayName: string;
  mainCharacterId: number | null;
  windows: Record<ActivityWindowKey, { epGained: number; gpSpent: number }>;
};

function emptyWindows(): AccountActivitySummary["windows"] {
  return Object.fromEntries(ACTIVITY_WINDOWS.map((window) => [window.key, { epGained: 0, gpSpent: 0 }])) as AccountActivitySummary["windows"];
}

export async function getOwnedAccountActivitySummaries(
  db: ReturnType<typeof drizzle>,
  userId: string,
  now = new Date(),
): Promise<AccountActivitySummary[]> {
  const owned = await db
    .select({ id: players.id, displayName: players.displayName, mainCharacterId: players.mainCharacterId })
    .from(players)
    .where(eq(players.userId, userId))
    .orderBy(players.displayName, players.id);
  if (owned.length === 0) return [];

  const playerIds = owned.map((player) => player.id);
  const oldest = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  const [epRows, gpRows] = await Promise.all([
    db
      .select({ playerId: epLedger.playerId, occurredAt: epLedger.occurredAt, points: epLedger.points })
      .from(epLedger)
      .where(and(inArray(epLedger.playerId, playerIds), gt(epLedger.points, 0))),
    db
      .select({ playerId: gpLedger.playerId, occurredAt: gpLedger.occurredAt, points: gpLedger.points })
      .from(gpLedger)
      .where(and(inArray(gpLedger.playerId, playerIds), gt(gpLedger.points, 0))),
  ]);

  const summaries = new Map<number, AccountActivitySummary>(
    owned.map((player) => [
      player.id,
      {
        playerId: player.id,
        displayName: player.displayName,
        mainCharacterId: player.mainCharacterId,
        windows: emptyWindows(),
      },
    ]),
  );

  const add = (playerId: number | null, occurredAt: Date, points: number, field: "epGained" | "gpSpent") => {
    if (playerId == null) return;
    const summary = summaries.get(playerId);
    if (!summary) return;
    summary.windows.all[field] += points;
    if (occurredAt < oldest) return;
    for (const window of ACTIVITY_WINDOWS) {
      if (window.milliseconds !== null && occurredAt.getTime() >= now.getTime() - window.milliseconds) {
        summary.windows[window.key][field] += points;
      }
    }
  };
  for (const row of epRows) add(row.playerId, row.occurredAt, row.points, "epGained");
  for (const row of gpRows) add(row.playerId, row.occurredAt, row.points, "gpSpent");

  return [...summaries.values()];
}
