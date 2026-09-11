import { getCloudflareContext } from "@opennextjs/cloudflare";
import { drizzle } from "drizzle-orm/d1";

import * as schema from "@/db";
import { watchD1 } from "@/lib/d1-watchdog";
import { timed } from "@/lib/perf";

export async function getDb() {
  const { env } = await timed("cfContext", () => getCloudflareContext({ async: true }));
  return drizzle(watchD1(env.DATABASE), { schema });
}
