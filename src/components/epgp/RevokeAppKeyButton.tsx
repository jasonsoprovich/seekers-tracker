"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { revokeAppKey } from "@/app/(app)/epgp/app-key/actions";

export function RevokeAppKeyButton({ keyId, name }: { keyId: string; name: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    if (!confirm(`Revoke "${name}"? Any app using this key will stop working immediately.`)) return;
    setPending(true);
    setError(null);
    const result = await revokeAppKey(keyId);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="text-sm font-medium text-red-400 hover:text-red-300 disabled:opacity-60"
      >
        {pending ? "Revoking…" : "Revoke"}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
