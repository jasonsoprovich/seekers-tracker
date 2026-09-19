import type { drizzle } from "drizzle-orm/d1";

import { rolePermissions } from "@/db";

import { applyOverrides, type PermissionMatrix } from "./capabilities";

// Takes a plain Drizzle handle (not getDb()'s Next-only wrapper) so both
// custom-worker.ts and src/lib/api-key-auth.ts — neither of which can call
// next/headers-dependent code — can resolve the live matrix the same way
// the app does. The Next-side cached wrapper is src/lib/permissions/index.ts.
export async function loadPermissionMatrix(db: ReturnType<typeof drizzle>): Promise<PermissionMatrix> {
  const rows = await db.select().from(rolePermissions);
  return applyOverrides(rows);
}
