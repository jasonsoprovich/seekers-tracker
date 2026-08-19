"use client";

import { useState } from "react";

import { requestClaim } from "@/app/(app)/characters/claim/actions";
import { Button } from "@/components/ui/Button";

export function ClaimThisCharacterButton({ characterId, alreadyPending }: { characterId: number; alreadyPending: boolean }) {
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(alreadyPending);

  async function submit() {
    setPending(true);
    setError(null);
    const result = await requestClaim(characterId, note);
    setPending(false);
    if (result?.error) {
      setError(result.error);
      return;
    }
    setSubmitted(true);
  }

  if (submitted) {
    return <p className="text-sm text-neutral-400">You've claimed this character — pending officer review.</p>;
  }

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <input
        type="text"
        placeholder="Note for officers (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        className="rounded-md border border-field bg-neutral-900 px-3 py-2 text-sm text-neutral-100 focus:border-accent focus:outline-none sm:w-64"
      />
      <Button type="button" size="sm" onClick={submit} disabled={pending}>
        {pending ? "Claiming…" : "Claim this character"}
      </Button>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
