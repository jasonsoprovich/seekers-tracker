import { getCloudflareContext } from "@opennextjs/cloudflare";
import { drizzle } from "drizzle-orm/d1";

import * as schema from "@/db";

export async function getDb() {
  const { env } = await getCloudflareContext({ async: true });
  return drizzle(env.DATABASE, { schema });
}
