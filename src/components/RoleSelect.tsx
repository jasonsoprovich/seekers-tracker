"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { setUserRole } from "@/app/admin/actions";
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
        className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 focus:border-emerald-500 focus:outline-none"
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
            {isSelf && r === role ? " (you)" : ""}
          </option>
        ))}
      </select>
      {value !== role && (
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="rounded-full bg-emerald-500 px-3 py-1 text-xs font-semibold text-black transition-colors hover:bg-emerald-400 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save"}
        </button>
      )}
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
