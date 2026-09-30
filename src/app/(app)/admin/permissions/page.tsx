import { redirect } from "next/navigation";

import { PermissionMatrixEditor } from "@/components/admin/PermissionMatrixEditor";
import { PageHeader } from "@/components/shell/PageHeader";
import { getRealUserRole, LEADERSHIP_ROLES } from "@/lib/authz";
import { capabilitiesByGroup, capabilityDef, defaultMatrix, getPermissionMatrix } from "@/lib/permissions";
import { getSession } from "@/lib/session";

// Leader + admin — gated on the REAL DB role, same as ViewAsControls, so an
// admin currently previewing a lower role can't accidentally lock
// themselves out of the one page that could undo it, and nobody's real
// officer role can ever reach it, however the matrix is configured (this
// page is deliberately excluded from CAPABILITIES itself — see
// src/lib/permissions/capabilities.ts's comment on the registry). Leaders
// can edit the Member and Officer columns only; the Leader column is
// admin-only (enforced server-side in actions.ts, the disabled column here
// is just the UI), and the Admin column is never editable by anyone.
export default async function AdminPermissionsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const realRole = await getRealUserRole(session.user.id);
  if (!realRole || !LEADERSHIP_ROLES.includes(realRole)) redirect("/admin");
  const readOnlyRoles = realRole === "admin" ? [] : (["leader"] as const);

  const effective = await getPermissionMatrix();
  const defaults = defaultMatrix();

  const groups = capabilitiesByGroup().map(({ group, capabilities }) => ({
    group,
    rows: capabilities.map((key) => {
      const def = capabilityDef(key);
      return {
        key,
        label: def.label,
        description: def.description,
        lockedRoles: def.lockedRoles ?? [],
        effective: effective[key],
        defaults: defaults[key],
      };
    }),
  }));

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        breadcrumbs={[{ label: "Admin", href: "/admin" }, { label: "Permissions" }]}
        title="Permissions"
        subtitle="Toggle which roles can do what. Member, Officer, and Leader are tunable (only admins can change the Leader column); Admin can always do everything and can't be changed. A cell greyed out and checked is locked — too destructive to hand to that role from here."
      />
      <PermissionMatrixEditor groups={groups} readOnlyRoles={readOnlyRoles} />
    </div>
  );
}
