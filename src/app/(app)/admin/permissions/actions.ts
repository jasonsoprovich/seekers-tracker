"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { rolePermissions } from "@/db";
import { getRealUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { capabilityDef, isCapability, isMatrixRole, type MatrixRole } from "@/lib/permissions";
import { getSession } from "@/lib/session";

export type PermissionCellInput = { capability: string; role: string; allowed: boolean };
export type SavePermissionsResult = { error?: string };

// Admin-only, checked against the REAL DB role (never getUserRole/
// getPermissions) — this page is deliberately excluded from its own
// registry (CAPABILITIES has no "admin.permissions.manage" entry) so an
// admin can never toggle themselves out of it, and nobody can grant an
// officer or leader the ability to change everyone's capabilities.
async function requireAdmin(): Promise<{ userId: string } | { error: string }> {
  const session = await getSession();
  if (!session) redirect("/login");
  const realRole = await getRealUserRole(session.user.id);
  if (realRole !== "admin") return { error: "Only admins can change permissions." };
  return { userId: session.user.id };
}

// Writes only the cells that actually differ from CAPABILITIES' own
// `defaults` — the table stays sparse (see role_permissions' schema
// comment), so "no overrides" always means "exactly as shipped" and a
// later registry change (a new capability, a changed default) takes effect
// immediately for everyone who never touched that cell. Cells belonging to
// a `lockedRoles` role, or naming an unknown capability/role, are silently
// dropped rather than erroring — the editor UI never sends them under
// normal use, but a forged request must not be able to unlock one.
export async function savePermissionMatrix(cells: PermissionCellInput[]): Promise<SavePermissionsResult> {
  const auth = await requireAdmin();
  if ("error" in auth) return auth;
  if (cells.length > 200) return { error: "Too many changes at once." };

  const db = await getDb();
  for (const cell of cells) {
    if (!isCapability(cell.capability) || !isMatrixRole(cell.role)) continue;
    const def = capabilityDef(cell.capability);
    if (def.lockedRoles?.includes(cell.role as MatrixRole)) continue;

    const isDefault = (def.defaults as readonly MatrixRole[]).includes(cell.role as MatrixRole) === cell.allowed;
    if (isDefault) {
      await db
        .delete(rolePermissions)
        .where(and(eq(rolePermissions.capability, cell.capability), eq(rolePermissions.role, cell.role as MatrixRole)));
    } else {
      await db
        .insert(rolePermissions)
        .values({ capability: cell.capability, role: cell.role as MatrixRole, allowed: cell.allowed, updatedBy: auth.userId, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [rolePermissions.capability, rolePermissions.role],
          set: { allowed: cell.allowed, updatedBy: auth.userId, updatedAt: new Date() },
        });
    }
  }

  // The nav, /admin's own link cards, and every gated page all read the
  // matrix fresh per request (cache()'d per-request, not a TTL) — a full
  // layout revalidation is what makes a toggle visible immediately rather
  // than after some other navigation happens to bust the cache.
  revalidatePath("/", "layout");
  return {};
}

export async function resetPermissionsToDefaults(): Promise<SavePermissionsResult> {
  const auth = await requireAdmin();
  if ("error" in auth) return auth;

  const db = await getDb();
  await db.delete(rolePermissions);
  revalidatePath("/", "layout");
  return {};
}
