import { clearViewAsRole } from "@/app/(app)/admin/view-as-actions";
import type { Role } from "@/lib/authz";

// Rendered by (app)/layout.tsx whenever a real admin has an active view-as
// preview — visible on every page, including ones the previewed role can't
// otherwise reach, so exiting is never more than one click away. A plain
// <form action> works with no client JS: submitting deletes the cookie and
// clearViewAsRole() redirects back to /admin.
export function ViewAsBanner({ role }: { role: Role }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 bg-amber-500 px-4 py-2 text-sm text-black">
      <span>
        Admin preview — viewing the site as <strong className="capitalize">{role}</strong>. Nav, pages, and
        actions are restricted exactly as they would be for that role.
      </span>
      <form action={clearViewAsRole}>
        <button
          type="submit"
          className="rounded-full bg-black/80 px-3 py-1 text-xs font-semibold text-amber-300 transition-colors hover:bg-black"
        >
          Exit preview → back to admin
        </button>
      </form>
    </div>
  );
}
