import { cache } from "react";

import { getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";

import { type Capability, type PermissionMatrix, roleCan } from "./capabilities";
import { loadPermissionMatrix } from "./db";

export * from "./capabilities";
export { loadPermissionMatrix } from "./db";

// cache()'d per request like getUserRole/getSession — role_permissions is
// tiny (at most a few dozen override rows) and read on nearly every page,
// so one query per request beats a TTL cache's staleness for an admin who
// just changed a toggle and wants to see it take effect immediately.
export const getPermissionMatrix = cache(async function getPermissionMatrix(): Promise<PermissionMatrix> {
  return loadPermissionMatrix(await getDb());
});

export type Permissions = {
  role: Awaited<ReturnType<typeof getUserRole>>;
  can: (capability: Capability) => boolean;
};

// The one call every server action/page should make: resolves the acting
// user's view-as-aware role (getUserRole already handles the admin preview
// cookie) and the live matrix in parallel, and hands back a closure so call
// sites read like `perms.can("members.remove")` instead of re-threading
// both values everywhere.
export const getPermissions = cache(async function getPermissions(userId: string): Promise<Permissions> {
  const [role, matrix] = await Promise.all([getUserRole(userId), getPermissionMatrix()]);
  return { role, can: (capability: Capability) => roleCan(matrix, role, capability) };
});

// The ownership-or-officer check repeated across every character route
// (view, edit, gear, stats, import): the owner can always manage their own
// character; anyone else needs the "characters.manageAny" capability.
export async function canManageCharacter(
  character: { ownerId: string | null } | undefined,
  userId: string,
): Promise<boolean> {
  if (!character) return false;
  if (character.ownerId === userId) return true;
  const perms = await getPermissions(userId);
  return perms.can("characters.manageAny");
}
