import { eq, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";
import { headers } from "next/headers";

import { characters, players, users } from "@/db";

type Db = ReturnType<typeof drizzle>;

export type SystemActor = {
  userId: string | null;
  label: string | null;
  role: string | null;
  source: "web" | "officer_api" | "cron" | "script";
  requestId?: string | null;
};

// Shared lookup behind webActor/officerApiActor. Deliberately reads
// users.role straight off the PASSED-IN db rather than calling
// src/lib/authz.ts's getRealUserRole — that helper resolves its own db via
// getCloudflareContext() internally, which only works inside a real
// Next.js/Workers request; every core this actor resolver is called from
// (players.ts, decay.ts, etc.) is also exercised directly by the
// scripts/verify-*.ts harnesses via getPlatformProxy, with no such request
// context to resolve. This is the real (un-preview-overridden) DB role —
// the same value getRealUserRole would return — so an admin previewing
// "leader" who makes a change is still logged as admin, just read without
// the view-as layer authz.ts's getUserRole would apply (irrelevant here,
// since a system-log entry always describes the REAL actor, never a
// preview). The display label is resolved the same way the Audit Trail tab
// already does (src/app/(app)/epgp/ledger/page.tsx) — an officer's own
// main character name, falling back to their username.
async function resolveActor(db: Db, userId: string, source: SystemActor["source"]): Promise<SystemActor> {
  const [row] = await db
    .select({
      role: users.role,
      username: users.username,
      mainCharacterName: sql<string | null>`(select c.name from ${players} p join ${characters} c on c.id = p.main_character_id where p.user_id = ${userId} limit 1)`,
    })
    .from(users)
    .where(eq(users.id, userId));
  return {
    userId,
    label: row?.mainCharacterName ?? row?.username ?? null,
    role: row?.role ?? null,
    source,
    requestId: await requestIdFromHeaders(),
  };
}

// Server actions and any core called synchronously within one — next/headers()
// works anywhere in that request's call graph, not just in the action file
// itself (this app's async context is real AsyncLocalStorage, per-request —
// see CLAUDE.md's freeze investigation).
export async function webActor(db: Db, userId: string): Promise<SystemActor> {
  return resolveActor(db, userId, "web");
}

// /api/officer/* routes — the userId comes from requireOfficerApiKey's
// resolved auth (src/lib/api-key-auth.ts), not a browser session.
export async function officerApiActor(db: Db, userId: string): Promise<SystemActor> {
  return resolveActor(db, userId, "officer_api");
}

export const CRON_ACTOR: SystemActor = { userId: null, label: "Scheduled job", role: null, source: "cron" };

export function scriptActor(label: string): SystemActor {
  return { userId: null, label, role: null, source: "script" };
}

// custom-worker.ts's REQUEST_ID_HEADER stamps x-request-id on every inbound
// request if absent, and src/lib/session.ts already reads it the same way.
// Best-effort: headers() throws outside a request context (a script run via
// getPlatformProxy has none), so scriptActor/CRON_ACTOR skip this entirely
// rather than calling it.
async function requestIdFromHeaders(): Promise<string | null> {
  try {
    const hdrs = await headers();
    return hdrs.get("x-request-id") ?? null;
  } catch {
    return null;
  }
}
