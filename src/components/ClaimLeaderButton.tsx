"use client";

import { useState } from "react";

import { claimLeaderRole } from "@/app/bootstrap-leader/actions";

export function ClaimLeaderButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function claim() {
    setPending(true);
    setError(null);
    const result = await claimLeaderRole();
    setPending(false);
    if (result?.error) setError(result.error);
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={claim}
        disabled={pending}
        className="rounded-full bg-emerald-500 px-6 py-3 font-semibold text-black transition-colors hover:bg-emerald-400 disabled:opacity-60"
      >
        {pending ? "Claiming…" : "Claim Leader Role"}
      </button>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
