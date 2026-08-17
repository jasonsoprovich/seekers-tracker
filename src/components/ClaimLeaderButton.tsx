"use client";

import { useState } from "react";

import { claimLeaderRole } from "@/app/(app)/bootstrap-leader/actions";
import { Button } from "@/components/ui/Button";

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
      <Button type="button" onClick={claim} disabled={pending}>
        {pending ? "Claiming…" : "Claim Leader Role"}
      </Button>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
