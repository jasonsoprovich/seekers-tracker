"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { setViewAsRole } from "@/app/(app)/admin/view-as-actions";
import { Button } from "@/components/ui/Button";
import type { Role } from "@/lib/authz";

const PREVIEW_ROLES: Role[] = ["member", "officer", "leader"];

// Entry point for admin/view-as-actions.ts's preview mode. Only rendered
// on /admin when the real (non-preview) role is admin — see admin/page.tsx.
// Picking a role sets an httpOnly cookie server-side, then refreshes: the
// current page re-renders under the previewed role immediately, which for
// /admin itself means an instant bounce to /characters for member/officer
// (exactly the point — admin/page.tsx's own guard does the work, nothing
// special-cased here).
export function ViewAsControls() {
  const router = useRouter();
  const [pending, setPending] = useState<Role | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function preview(role: Role) {
    setPending(role);
    setError(null);
    const result = await setViewAsRole(role);
    if (result?.error) {
      setError(result.error);
      setPending(null);
      return;
    }
    router.refresh();
  }

  return (
    <section className="mb-10 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
      <h2 className="text-lg font-semibold">Preview as another role</h2>
      <p className="mt-1 text-sm text-neutral-400">
        See the site exactly as a member, officer, or leader would — nav links, pages, and server-side
        actions all follow the previewed role. A banner stays visible everywhere with a one-click way
        back.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {PREVIEW_ROLES.map((r) => (
          <Button key={r} type="button" variant="outline" size="sm" disabled={pending !== null} onClick={() => preview(r)}>
            {pending === r ? "Switching…" : `View as ${r}`}
          </Button>
        ))}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </section>
  );
}
