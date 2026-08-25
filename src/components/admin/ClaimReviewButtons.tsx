"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { approveClaim, denyClaim } from "@/app/(app)/admin/claims/actions";
import { useConfirm } from "@/components/ui/ConfirmDialog";

// Approve fired immediately with no confirmation of any kind until
// 2026-08-25 — the only mutation of the 8-site confirmation audit that had
// none at all (Deny already has its own two-step reveal-a-reason-field
// flow below, so it's left as-is). Approving hands the requester ownership
// of the character immediately.
export function ClaimReviewButtons({ claimId }: { claimId: number }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [denying, setDenying] = useState(false);
  const [note, setNote] = useState("");

  async function onApprove() {
    const ok = await confirm({
      title: "Approve claim?",
      message: "Approve this claim? The requester becomes the owner of this character immediately.",
      confirmLabel: "Approve",
    });
    if (!ok) return;
    setPending(true);
    setError(null);
    const result = await approveClaim(claimId);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  async function onDeny() {
    setPending(true);
    setError(null);
    const result = await denyClaim(claimId, note);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  if (denying) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="Reason (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="rounded-md border border-field bg-neutral-900 px-2 py-1 text-sm text-neutral-100 focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            onClick={onDeny}
            disabled={pending}
            className="text-sm font-medium text-red-400 hover:text-red-300 disabled:opacity-60"
          >
            {pending ? "Denying…" : "Confirm deny"}
          </button>
          <button type="button" onClick={() => setDenying(false)} disabled={pending} className="text-sm text-neutral-500 hover:text-neutral-300">
            Cancel
          </button>
        </div>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={onApprove}
          disabled={pending}
          className="text-sm font-medium text-emerald-400 hover:text-emerald-300 disabled:opacity-60"
        >
          {pending ? "Approving…" : "Approve"}
        </button>
        <button
          type="button"
          onClick={() => setDenying(true)}
          disabled={pending}
          className="text-sm font-medium text-red-400 hover:text-red-300 disabled:opacity-60"
        >
          Deny
        </button>
      </div>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
