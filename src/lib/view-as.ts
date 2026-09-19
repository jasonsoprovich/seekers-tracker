export const VIEW_AS_COOKIE = "seekers_view_as_role";
export const VIEW_AS_ROLES = ["member", "officer", "leader"] as const;
export type ViewAsRole = (typeof VIEW_AS_ROLES)[number];

export function isViewAsRole(value: string | undefined): value is ViewAsRole {
  return value !== undefined && (VIEW_AS_ROLES as readonly string[]).includes(value);
}

export function viewAsRoleFromCookieHeader(cookieHeader: string | null): ViewAsRole | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== VIEW_AS_COOKIE) continue;
    const raw = part.slice(separator + 1).trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      return null;
    }
    return isViewAsRole(value) ? value : null;
  }
  return null;
}

export function effectiveRoleWithViewAs(realRole: string | null, cookieHeader: string | null): string | null {
  return realRole === "admin" ? (viewAsRoleFromCookieHeader(cookieHeader) ?? realRole) : realRole;
}
