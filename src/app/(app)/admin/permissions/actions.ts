"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { rolePermissions } from "@/db";
import { getRealUserRole, LEADERSHIP_ROLES } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { capabilityDef, getPermissionMatrix, isCapability, isMatrixRole, type MatrixRole } from "@/lib/permissions";
import { getSession } from "@/lib/session";
import { recordSystemEvent, webActor } from "@/lib/system-log";

export type PermissionCellInput = { capability: string; role: string; allowed: boolean };
export type SavePermissionsResult = { error?: string };

// Leader or admin, checked against the REAL DB role (never getUserRole/
// getPermissions) — this page is deliberately excluded from its own
// registry (CAPABILITIES has no "admin.permissions.manage" entry) so nobody
// can toggle themselves out of it, and nobody can grant an officer the
// ability to change everyone's capabilities. A leader may edit the Member
// and Officer columns only; `canEditLeaderColumn` is false for them.
async function requireLeadership(): Promise<{ userId: string; canEditLeaderColumn: boolean } | { error: string }> {
  const session = await getSession();
  if (!session) redirect("/login");
  const realRole = await getRealUserRole(session.user.id);
  if (!realRole || !LEADERSHIP_ROLES.includes(realRole)) return { error: "Only leaders and admins can change permissions." };
  return { userId: session.user.id, canEditLeaderColumn: realRole === "admin" };
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
  const auth = await requireLeadership();
  if ("error" in auth) return auth;
  if (cells.length > 200) return { error: "Too many changes at once." };

  const db = await getDb();
  const before = await getPermissionMatrix();
  if (!auth.canEditLeaderColumn) {
    const touchesLeader = cells.some(
      (c) => isCapability(c.capability) && c.role === "leader" && before[c.capability].leader !== c.allowed,
    );
    if (touchesLeader) return { error: "Only admins can change Leader permissions." };
  }
  const changes: { capability: string; role: MatrixRole; before: boolean; after: boolean }[] = [];

  for (const cell of cells) {
    if (!isCapability(cell.capability) || !isMatrixRole(cell.role)) continue;
    // A leader's unchanged Leader cells are a no-op, not a write.
    if (cell.role === "leader" && !auth.canEditLeaderColumn) continue;
    const def = capabilityDef(cell.capability);
    if (def.lockedRoles?.includes(cell.role as MatrixRole)) continue;

    const wasAllowed = before[cell.capability][cell.role as MatrixRole];
    if (wasAllowed !== cell.allowed) {
      changes.push({ capability: cell.capability, role: cell.role as MatrixRole, before: wasAllowed, after: cell.allowed });
    }

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

  if (changes.length > 0) {
    const actor = await webActor(db, auth.userId);
    await recordSystemEvent(db, actor, {
      action: "permissions.save",
      summary: `Permission matrix changed: ${changes.map((c) => `${c.capability}/${c.role} ${c.before ? "on" : "off"}→${c.after ? "on" : "off"}`).join(", ")}`,
      before: Object.fromEntries(changes.map((c) => [`${c.capability}.${c.role}`, c.before])),
      after: Object.fromEntries(changes.map((c) => [`${c.capability}.${c.role}`, c.after])),
    });
  }

  // The nav, /admin's own link cards, and every gated page all read the
  // matrix fresh per request (cache()'d per-request, not a TTL) — a full
  // layout revalidation is what makes a toggle visible immediately rather
  // than after some other navigation happens to bust the cache.
  revalidatePath("/", "layout");
  return {};
}

// A leader's reset only clears the Member and Officer overrides; Leader-
// column overrides stay (admin-only). An admin's reset clears everything.
export async function resetPermissionsToDefaults(): Promise<SavePermissionsResult> {
  const auth = await requireLeadership();
  if ("error" in auth) return auth;

  const db = await getDb();
  if (auth.canEditLeaderColumn) await db.delete(rolePermissions);
  else await db.delete(rolePermissions).where(inArray(rolePermissions.role, ["member", "officer"]));
  const actor = await webActor(db, auth.userId);
  await recordSystemEvent(db, actor, {
    action: "permissions.reset",
    summary: auth.canEditLeaderColumn ? "Permission matrix reset to defaults" : "Member and Officer permissions reset to defaults",
  });
  revalidatePath("/", "layout");
  return {};
}
