"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { setPlayerMainCharacter } from "@/app/(app)/admin/actions";
import { Button } from "@/components/ui/Button";
import { fieldClasses } from "@/components/ui/Field";

export type MainCharacterOption = { id: number; name: string };

// Mirrors RoleSelect.tsx's shape (PLAN.md §11 Phase 10 task 10.3) — pick,
// then a Save button appears only once the selection actually changed.
export function MainCharacterSelect({
  playerId,
  options,
  currentMainCharacterId,
}: {
  playerId: number;
  options: MainCharacterOption[];
  currentMainCharacterId: number | null;
}) {
  const router = useRouter();
  const [value, setValue] = useState<number | null>(currentMainCharacterId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (value === null) return;
    setPending(true);
    setError(null);
    const result = await setPlayerMainCharacter(playerId, value);
    setPending(false);
    if (result.error) {
      setError(result.error);
      setValue(currentMainCharacterId);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      <select
        value={value ?? ""}
        onChange={(e) => setValue(e.target.value ? Number(e.target.value) : null)}
        disabled={pending}
        className={fieldClasses({ size: "sm" })}
      >
        {currentMainCharacterId === null && <option value="">(no main set)</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
            {o.id === currentMainCharacterId ? " (current main)" : ""}
          </option>
        ))}
      </select>
      {value !== currentMainCharacterId && (
        <Button type="button" onClick={save} disabled={pending} size="sm">
          {pending ? "Saving…" : "Save"}
        </Button>
      )}
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
