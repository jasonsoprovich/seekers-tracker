import { getCloudflareContext } from "@opennextjs/cloudflare";
import Link from "next/link";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/shell/PageHeader";
import { Card } from "@/components/ui/Card";
import { canManageAnyCharacter, canManageEpgpConfig, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { guildDateTime } from "@/lib/guild-timezone";
import { getSession } from "@/lib/session";
import { getSystemHealth, isWithinTimeTravelWindow } from "@/lib/system-health";

function formatBytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function abbreviated(bookmark: string): string {
  return bookmark.length > 22 ? `${bookmark.slice(0, 10)}...${bookmark.slice(-8)}` : bookmark;
}

export default async function SystemHealthPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const role = await getUserRole(session.user.id);
  if (!canManageAnyCharacter(role)) redirect("/characters");

  const [{ env }, db] = await Promise.all([getCloudflareContext({ async: true }), getDb()]);
  const health = await getSystemHealth(db, env.IMPORT_ARCHIVE);
  const lastBackup = health.backup?.lastSuccess;
  const lastRebuild = health.rebuild?.lastSuccess;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="System Health" subtitle="Read-only recovery and maintenance status. Restore operations remain operator-only CLI procedures." />

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="font-semibold">Standings</h2>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-neutral-500">Dirty markers</dt><dd className={health.dirty.count ? "text-amber-400" : "text-emerald-400"}>{health.dirty.count ? `${health.dirty.count} pending${health.dirty.global ? " (global)" : ""}` : "Clear"}</dd></div>
            <div><dt className="text-neutral-500">Oldest dirty marker</dt><dd>{health.dirty.oldestAt ? guildDateTime(health.dirty.oldestAt) : "None"}</dd></div>
            <div><dt className="text-neutral-500">Last full rebuild</dt><dd>{lastRebuild?.completedAt ? guildDateTime(lastRebuild.completedAt) : "Not recorded yet"}</dd></div>
            <div><dt className="text-neutral-500">Last rebuild source</dt><dd>{lastRebuild?.source ?? "Unknown"}{lastRebuild?.players != null ? ` (${lastRebuild.players} players)` : ""}</dd></div>
          </dl>
          {health.dirty.malformed > 0 && <p className="mt-4 text-sm text-red-400">{health.dirty.malformed} malformed dirty scope{health.dirty.malformed === 1 ? "" : "s"} require investigation.</p>}
          {health.rebuild?.latestAttempt.status === "failed" && <p className="mt-4 text-sm text-red-400">Latest rebuild failed: {health.rebuild.latestAttempt.error ?? "unknown error"}</p>}
          {canManageEpgpConfig(role) && <Link href="/epgp/settings" className="mt-4 inline-block text-sm text-emerald-400 hover:text-emerald-300">Maintenance controls</Link>}
        </Card>

        <Card className="p-5">
          <h2 className="font-semibold">Portable Backups</h2>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-neutral-500">Cadence</dt><dd>Configured daily at 09:00 UTC</dd></div>
            <div><dt className="text-neutral-500">Retention</dt><dd>{health.policy.backupKeepCount} newest exports</dd></div>
            <div><dt className="text-neutral-500">Last successful export</dt><dd>{lastBackup ? guildDateTime(lastBackup.completedAt) : "None recorded"}</dd></div>
            <div><dt className="text-neutral-500">Last export size</dt><dd>{lastBackup ? formatBytes(lastBackup.objectSize) : "Unknown"}</dd></div>
          </dl>
          {health.backup?.latestAttempt.status === "failed" && <p className="mt-4 text-sm text-red-400">Latest backup failed: {health.backup.latestAttempt.error ?? "unknown error"}</p>}
          {!lastBackup && <p className="mt-4 text-sm text-amber-400">Deployment is pending the scoped API token; no successful portable export is recorded.</p>}
        </Card>

        <Card className="p-5">
          <h2 className="font-semibold">Recovery Policy</h2>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-neutral-500">D1 Time Travel</dt><dd>{health.policy.timeTravelDays} days</dd></div>
            <div><dt className="text-neutral-500">Policy verified</dt><dd>{guildDateTime(health.policy.verifiedAt)}</dd></div>
          </dl>
          <p className="mt-4 text-sm text-neutral-400">Time Travel is the fast recovery path. R2 SQL exports are the portable account-level hedge.</p>
        </Card>

        <Card className="p-5">
          <h2 className="font-semibold">Named Restore Points</h2>
          {health.restorePoints.length === 0 ? (
            <p className="mt-4 text-sm text-amber-400">No R2 restore-point registry is available yet.</p>
          ) : (
            <ul className="mt-4 max-h-64 space-y-3 overflow-y-auto text-sm">
              {health.restorePoints.slice(0, 20).map((point) => (
                <li key={`${point.createdAt}-${point.bookmark}`} className="border-b border-border pb-3 last:border-0">
                  <p className="font-medium text-neutral-200">{point.label}</p>
                  <p className="mt-1 text-neutral-500">
                    {guildDateTime(point.createdAt)} · <code>{abbreviated(point.bookmark)}</code> · {isWithinTimeTravelWindow(point.createdAt) ? "within 30-day window" : "older than 30-day window"}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-4 text-xs text-neutral-500">Metadata only. This page intentionally has no restore action.</p>
        </Card>
      </div>
    </div>
  );
}
