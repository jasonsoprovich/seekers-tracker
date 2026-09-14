import type { drizzle } from "drizzle-orm/d1";

import { standingsDirty } from "@/db";
import { rebuildAllStandings } from "@/lib/epgp/standings";

export const REBUILD_STATUS_KEY = "system-health/standings-rebuild.json";
export const BACKUP_STATUS_KEY = "system-health/backup.json";
export const RESTORE_POINTS_KEY = "system-health/restore-points.tsv";

export const RECOVERY_POLICY = {
  verifiedAt: "2026-09-14T00:00:00Z",
  timeTravelDays: 30,
  backupCron: "0 9 * * *",
  backupKeepCount: 35,
  backupDeploymentStatus: "pending-secret",
} as const;

export type RebuildSource = "nightly-cron" | "settings-action" | "officer-api";
type RebuildAttempt = {
  status: "running" | "succeeded" | "failed";
  source: RebuildSource;
  startedAt: string;
  completedAt?: string;
  failedAt?: string;
  players?: number;
  durationMs?: number;
  error?: string;
};
export type RebuildStatus = { schemaVersion: 1; latestAttempt: RebuildAttempt; lastSuccess?: RebuildAttempt };

export type BackupStatus = {
  schemaVersion: 1;
  latestAttempt: {
    status: "running" | "succeeded" | "failed";
    instanceId: string;
    startedAt: string;
    completedAt?: string;
    failedAt?: string;
    error?: string;
  };
  lastSuccess?: {
    completedAt: string;
    objectKey: string;
    objectSize: number;
    bookmark: string;
    retainedObjects: number;
  };
};

export type RestorePoint = { createdAt: string; bookmark: string; label: string };

export function isWithinTimeTravelWindow(createdAt: string, now = Date.now()): boolean {
  const created = Date.parse(createdAt);
  return Number.isFinite(created) && now - created <= RECOVERY_POLICY.timeTravelDays * 24 * 60 * 60 * 1000;
}

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  try {
    const object = await bucket.get(key);
    if (!object) return null;
    const value = JSON.parse(await object.text()) as T;
    return value && typeof value === "object" ? value : null;
  } catch (error) {
    console.error(`[system-health] couldn't read ${key}: ${error}`);
    return null;
  }
}

async function writeRebuildStatus(bucket: R2Bucket, status: RebuildStatus): Promise<void> {
  await bucket.put(REBUILD_STATUS_KEY, JSON.stringify(status), { httpMetadata: { contentType: "application/json" } });
}

function shortError(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, 300);
}

export async function runRecordedStandingsRebuild(
  db: ReturnType<typeof drizzle>,
  bucket: R2Bucket,
  source: RebuildSource,
): Promise<{ players: number }> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const previous = await readJson<RebuildStatus>(bucket, REBUILD_STATUS_KEY);
  const running: RebuildStatus = {
    schemaVersion: 1,
    latestAttempt: { status: "running", source, startedAt },
    ...(previous?.lastSuccess ? { lastSuccess: previous.lastSuccess } : {}),
  };
  try {
    await writeRebuildStatus(bucket, running);
  } catch (error) {
    console.error(`[system-health] couldn't record rebuild start: ${error}`);
  }

  try {
    const result = await rebuildAllStandings(db);
    const completedAt = new Date().toISOString();
    const success: RebuildAttempt = {
      status: "succeeded",
      source,
      startedAt,
      completedAt,
      players: result.players,
      durationMs: Date.now() - started,
    };
    try {
      await writeRebuildStatus(bucket, { schemaVersion: 1, latestAttempt: success, lastSuccess: success });
    } catch (error) {
      console.error(`[system-health] standings rebuilt but success metadata failed: ${error}`);
    }
    return result;
  } catch (error) {
    const failed: RebuildAttempt = { status: "failed", source, startedAt, failedAt: new Date().toISOString(), error: shortError(error) };
    try {
      await writeRebuildStatus(bucket, { ...running, latestAttempt: failed });
    } catch (metadataError) {
      console.error(`[system-health] couldn't record rebuild failure: ${metadataError}`);
    }
    throw error;
  }
}

async function readRestorePoints(bucket: R2Bucket): Promise<RestorePoint[]> {
  try {
    const object = await bucket.get(RESTORE_POINTS_KEY);
    if (!object) return [];
    return (await object.text())
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        const [createdAt, bookmark, ...label] = line.split("\t");
        return createdAt && bookmark && label.length > 0 ? [{ createdAt, bookmark, label: label.join("\t") }] : [];
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch (error) {
    console.error(`[system-health] couldn't read restore points: ${error}`);
    return [];
  }
}

export async function getSystemHealth(db: ReturnType<typeof drizzle>, bucket: R2Bucket) {
  const [dirtyRows, rebuild, backup, restorePoints] = await Promise.all([
    db.select().from(standingsDirty),
    readJson<RebuildStatus>(bucket, REBUILD_STATUS_KEY),
    readJson<BackupStatus>(bucket, BACKUP_STATUS_KEY),
    readRestorePoints(bucket),
  ]);
  const malformedScopes = dirtyRows.filter((row) => row.scope !== "all" && !/^player:\d+$/.test(row.scope));
  return {
    dirty: {
      count: dirtyRows.length,
      global: dirtyRows.some((row) => row.scope === "all"),
      malformed: malformedScopes.length,
      oldestAt: dirtyRows.reduce<Date | null>((oldest, row) => (!oldest || row.markedAt < oldest ? row.markedAt : oldest), null),
    },
    rebuild,
    backup,
    restorePoints,
    policy: RECOVERY_POLICY,
  };
}
