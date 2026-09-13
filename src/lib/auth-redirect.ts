export const DEFAULT_SIGN_IN_DESTINATION = "/characters";

export function sanitizeSignInDestination(value: string | string[] | null | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\")) {
    return DEFAULT_SIGN_IN_DESTINATION;
  }

  try {
    const destination = new URL(candidate, "https://seekers.internal");
    if (destination.origin !== "https://seekers.internal" || destination.pathname === "/login") {
      return DEFAULT_SIGN_IN_DESTINATION;
    }
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return DEFAULT_SIGN_IN_DESTINATION;
  }
}
