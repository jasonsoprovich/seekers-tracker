"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { setUserRole } from "@/app/(app)/admin/actions";
import { Button } from "@/components/ui/Button";
import { fieldClasses } from "@/components/ui/Field";
import type { Role } from "@/lib/authz";

const ROLES: Role[] = ["member", "officer", "leader"];

export function RoleSelect({
  userId,
  role,
  isSelf,
}: {
  userId: string;
  role: Role;
  isSelf: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState<Role>(role);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setPending(true);
    setError(null);
    const result = await setUserRole(userId, value);
    setPending(false);
    if (result.error) {
      setError(result.error);
      setValue(role);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      <select
        value={value}
        onChange={(e) => setValue(e.target.value as Role)}
        disabled={pending}
        className={fieldClasses({ size: "sm" })}
      >
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
    </div>
  );
}
