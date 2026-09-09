import { sql } from "drizzle-orm";

import { getDb } from "@/lib/db";

// Health / keep-warm endpoint. Hit every 3 min by the cron in
// custom-worker.ts's scheduled() so a render-path isolate stays hot
// (LT-26/LT-27), and usable as a plain liveness check. Deliberately
// minimal: exercise the OpenNext render path, the Next runtime, the D1
// binding and drizzle — nothing else — so it barely costs any CPU.
// Unauthenticated on purpose; it returns no data.
export const dynamic = "force-dynamic";

// Inlined at build time by next.config.ts's `env` (the commit SHA). The
// client bundle carries its own copy of the same value; VersionGuard polls
// this route and compares, so a tab can tell when the deployed build has
// moved on under it. `?? null` so this stays valid JSON if the var is ever
// missing.
const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? null;

export async function GET() {
  const t0 = Date.now();
  try {
    const db = await getDb();
    await db.run(sql`SELECT 1`);
    return Response.json({ ok: true, ms: Date.now() - t0, buildId: BUILD_ID });
  } catch (e) {
    return Response.json(
      { ok: false, ms: Date.now() - t0, buildId: BUILD_ID, error: String(e) },
      { status: 500 },
    );
  }
}
