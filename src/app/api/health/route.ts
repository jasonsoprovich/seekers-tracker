import { sql } from "drizzle-orm";

import { getDb } from "@/lib/db";

// Health / keep-warm endpoint. Hit every 3 min by the cron in
// custom-worker.ts's scheduled() so a render-path isolate stays hot
// (LT-26/LT-27), and usable as a plain liveness check. Deliberately
// minimal: exercise the OpenNext render path, the Next runtime, the D1
// binding and drizzle — nothing else — so it barely costs any CPU.
// Unauthenticated on purpose; it returns no data.
export const dynamic = "force-dynamic";

export async function GET() {
  const t0 = Date.now();
  try {
    const db = await getDb();
    await db.run(sql`SELECT 1`);
    return Response.json({ ok: true, ms: Date.now() - t0 });
  } catch (e) {
    return Response.json({ ok: false, ms: Date.now() - t0, error: String(e) }, { status: 500 });
  }
}
