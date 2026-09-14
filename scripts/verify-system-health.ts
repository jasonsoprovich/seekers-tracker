// Phase 10.6/10.7: local D1 + R2 integration coverage for the read-only
// health model and recorded standings rebuild. Never uses remote bindings.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import * as schema from "../src/db";
import { standingsDirty } from "../src/db";
import {
  BACKUP_STATUS_KEY,
  getSystemHealth,
  REBUILD_STATUS_KEY,
  RESTORE_POINTS_KEY,
  runRecordedStandingsRebuild,
  isWithinTimeTravelWindow,
  type BackupStatus,
} from "../src/lib/system-health";

const SNAPSHOT = "phase10-system-health-test";
const KEYS = [BACKUP_STATUS_KEY, REBUILD_STATUS_KEY, RESTORE_POINTS_KEY];

async function main() {
  execFileSync("scripts/snapshot.sh", ["save", SNAPSHOT], { stdio: "inherit" });
  const proxy = await getPlatformProxy({ configPath: "wrangler.jsonc" });
  const db = drizzle(proxy.env.DATABASE as unknown as Parameters<typeof drizzle>[0], { schema });
  const bucket = proxy.env.IMPORT_ARCHIVE as unknown as R2Bucket;
  const originals = new Map<string, { body: ArrayBuffer; contentType?: string } | null>();

  try {
    for (const key of KEYS) {
      const object = await bucket.get(key);
      originals.set(key, object ? { body: await object.arrayBuffer(), contentType: object.httpMetadata?.contentType } : null);
    }

    const backup: BackupStatus = {
      schemaVersion: 1,
      latestAttempt: { status: "succeeded", instanceId: "verify", startedAt: "2026-09-14T08:59:00Z", completedAt: "2026-09-14T09:00:00Z" },
      lastSuccess: { completedAt: "2026-09-14T09:00:00Z", objectKey: "seekers-of-souls/verify.sql", objectSize: 1234, bookmark: "bookmark", retainedObjects: 1 },
    };
    await bucket.put(BACKUP_STATUS_KEY, JSON.stringify(backup));
    await bucket.put(RESTORE_POINTS_KEY, "2026-09-14T00:00:00Z\tbookmark-new\tnew point\n2026-09-13T00:00:00Z\tbookmark-old\told point\n");
    const rebuilt = await runRecordedStandingsRebuild(db, bucket, "settings-action");
    assert.ok(rebuilt.players > 0);
    await db.insert(standingsDirty).values({ scope: "malformed-test-scope" }).onConflictDoNothing();
    const health = await getSystemHealth(db, bucket);
    assert.equal(health.rebuild?.lastSuccess?.status, "succeeded");
    assert.equal(health.rebuild?.lastSuccess?.source, "settings-action");
    assert.equal(health.backup?.lastSuccess?.objectSize, 1234);
    assert.equal(health.restorePoints[0]?.label, "new point");
    assert.equal(health.restorePoints[1]?.label, "old point");
    assert.equal(health.dirty.malformed, 1);
    assert.equal(health.policy.timeTravelDays, 30);
    assert.equal(health.policy.backupKeepCount, 35);
    assert.equal(isWithinTimeTravelWindow("2026-09-01T00:00:00Z", Date.parse("2026-09-14T00:00:00Z")), true);
    assert.equal(isWithinTimeTravelWindow("2026-08-01T00:00:00Z", Date.parse("2026-09-14T00:00:00Z")), false);
    console.log("System Health integration checks passed.");
  } finally {
    for (const [key, original] of originals) {
      if (original) await bucket.put(key, original.body, { httpMetadata: { contentType: original.contentType } });
      else await bucket.delete(key);
    }
    await proxy.dispose();
    execFileSync("scripts/snapshot.sh", ["restore", SNAPSHOT], { stdio: "inherit" });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
