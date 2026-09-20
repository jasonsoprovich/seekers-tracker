import type { drizzle } from "drizzle-orm/d1";

import { systemEventLog } from "@/db";

import { systemEventDef, type SystemEventAction } from "./events";

export { SYSTEM_EVENTS, SYSTEM_EVENT_ACTIONS, SYSTEM_EVENT_CATEGORIES, isSystemEventCategory, systemEventDef } from "./events";
export type { SystemEventAction, SystemEventCategory } from "./events";
export { CRON_ACTOR, officerApiActor, scriptActor, webActor } from "./actor";
export type { SystemActor } from "./actor";

type Db = ReturnType<typeof drizzle>;

export type SystemEventInput = {
  action: SystemEventAction;
  targetType?: string;
  targetId?: string | number | null;
  targetLabel?: string | null;
  summary: string;
  before?: unknown;
  after?: unknown;
};

// The one place every mutation logs from. Deliberately fire-and-forget —
// mirrors settleStandings (src/lib/epgp/standings.ts): a bookkeeping write
// failing must never fail the caller's real mutation (a role change, a
// removal). A lost log line is strictly better than a rolled-back one.
export async function recordSystemEvent(
  db: Db,
  actor: { userId: string | null; label: string | null; role: string | null; source: "web" | "officer_api" | "cron" | "script"; requestId?: string | null },
  event: SystemEventInput,
): Promise<void> {
  try {
    const def = systemEventDef(event.action);
    await db.insert(systemEventLog).values({
      actorUserId: actor.userId,
      actorLabel: actor.label,
      actorRole: actor.role,
      source: actor.source,
      category: def.category,
      action: event.action,
      targetType: event.targetType ?? null,
      targetId: event.targetId != null ? String(event.targetId) : null,
      targetLabel: event.targetLabel ?? null,
      summary: event.summary,
      before: event.before ?? null,
      after: event.after ?? null,
      requestId: actor.requestId ?? null,
    });
  } catch (err) {
    console.error("[system-log] failed to record event", event.action, err);
  }
}

// For inclusion in an existing db.batch() — mirrors prepareDeleteAudit's
// shape in src/lib/epgp/ledger-audit.ts. Used where the mutation itself is
// already one atomic batch (bid finalization, raid/decay reversal) so the
// log row commits or rolls back with what it describes, rather than being
// a separate best-effort write after the fact.
export function systemEventStatement(
  d1: D1Database,
  actor: { userId: string | null; label: string | null; role: string | null; source: "web" | "officer_api" | "cron" | "script"; requestId?: string | null },
  event: SystemEventInput,
): D1PreparedStatement {
  const def = systemEventDef(event.action);
  return d1
    .prepare(`
      INSERT INTO system_event_log
        (actor_user_id, actor_label, actor_role, source, category, action, target_type, target_id, target_label, summary, before, after, request_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      actor.userId,
      actor.label,
      actor.role,
      actor.source,
      def.category,
      event.action,
      event.targetType ?? null,
      event.targetId != null ? String(event.targetId) : null,
      event.targetLabel ?? null,
      event.summary,
      event.before != null ? JSON.stringify(event.before) : null,
      event.after != null ? JSON.stringify(event.after) : null,
      actor.requestId ?? null,
    );
}
