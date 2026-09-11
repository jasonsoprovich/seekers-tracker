"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { setPlayerRole } from "@/app/(app)/characters/[id]/account/actions";
import { Button } from "@/components/ui/Button";
import { fieldClasses } from "@/components/ui/Field";
import type { Role } from "@/lib/authz";

// Mirrors ROLES in src/lib/authz.ts — that module pulls in next/headers,
// which a client component can't import.
const ROLES: Role[] = ["member", "officer", "leader", "admin"];

// Leader/admin role picker for an ACCOUNT (players.role) — works whether or
// not anyone has claimed it. Same shape as RoleSelect (the admin page's
// per-login picker); this one is keyed by player and lives on the Account
// tab, so an officer who has never logged in can still be marked officer.
export function PlayerRoleSelect({ playerId, role, isSelf }: { playerId: number; role: Role; isSelf: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState<Role>(role);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setPending(true);
    setError(null);
    const result = await setPlayerRole(playerId, value);
    setPending(false);
    if (result.error) {
      setError(result.error);
      setValue(role);
      return;
    }
    router.refresh();
  }

  return (
    <span className="inline-flex items-center gap-2">
      <select value={value} onChange={(e) => setValue(e.target.value as Role)} disabled={pending} className={fieldClasses({ size: "sm" })}>
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
            {isSelf && r === role ? " (you)" : ""}
          </option>
        ))}
      </select>
      {value !== role && (
        <Button type="button" onClick={save} disabled={pending} size="sm">
          {pending ? "Saving…" : "Save"}
        </Button>
      )}
      {error && <span className="text-xs text-red-400">{error}</span>}
    </span>
  );
}
