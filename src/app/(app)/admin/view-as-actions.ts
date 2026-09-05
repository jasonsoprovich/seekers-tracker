"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getRealUserRole, VIEW_AS_COOKIE, VIEW_AS_ROLES, type Role } from "@/lib/authz";
import { getSession } from "@/lib/session";

export type ViewAsResult = { error?: string };

// Only a real admin may enter preview mode — gated on getRealUserRole, not
// getUserRole, so this can't be re-entered from inside an active preview
// (where getUserRole would already report the previewed role) and can't be
// forged by anyone whose actual DB role isn't admin.
export async function setViewAsRole(role: string): Promise<ViewAsResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const realRole = await getRealUserRole(session.user.id);
  if (realRole !== "admin") {
    return { error: "Only admins can preview the site as another role." };
  }
  if (!(VIEW_AS_ROLES as readonly string[]).includes(role)) {
    return { error: "Invalid preview role." };
  }

  const store = await cookies();
  store.set(VIEW_AS_COOKIE, role as Role, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // Safety net so a forgotten preview doesn't linger indefinitely.
    maxAge: 60 * 60 * 4,
  });

  return {};
}

// Deliberately no role/session check beyond "is logged in": deleting the
// preview cookie can only ever fall back to the real (admin) role, never
// grant anything, so there's nothing to gate here.
export async function clearViewAsRole(): Promise<void> {
  const session = await getSession();
  if (!session) redirect("/login");

  const store = await cookies();
  store.delete(VIEW_AS_COOKIE);
  redirect("/admin");
}
