"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { updateTimezoneAction } from "@/app/(app)/profile/actions";
import { Button } from "@/components/ui/Button";
import { fieldClasses } from "@/components/ui/Field";
import { COMMON_TIMEZONES } from "@/lib/common-timezones";

const GUILD_DEFAULT = "";

export function ProfileTimezoneForm({ currentTimezone }: { currentTimezone: string | null }) {
  const router = useRouter();
  const [value, setValue] = useState(currentTimezone ?? GUILD_DEFAULT);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setPending(true);
    setError(null);
    setSaved(false);
    const result = await updateTimezoneAction(value);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select value={value} onChange={(e) => setValue(e.target.value)} className={fieldClasses({ size: "sm" })}>
        <option value={GUILD_DEFAULT}>Guild default (Eastern)</option>
        {COMMON_TIMEZONES.map((tz) => (
          <option key={tz.value} value={tz.value}>
            {tz.label}
          </option>
        ))}
      </select>
      <Button type="button" size="sm" onClick={save} disabled={pending || value === (currentTimezone ?? GUILD_DEFAULT)}>
        {pending ? "Saving…" : "Save"}
      </Button>
      {saved && <span className="text-sm text-emerald-400">Saved.</span>}
      {error && <span className="text-sm text-red-400">{error}</span>}
    </div>
  );
}
