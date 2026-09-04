"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { updateSetting } from "@/app/(app)/epgp/settings/actions";
import { Button } from "@/components/ui/Button";
import { fieldClasses } from "@/components/ui/Field";

export type SettingHistoryEntry = {
  value: string;
  effectiveFrom: string;
  changedByName: string | null;
  changedAt: string;
  note: string | null;
};

export function SettingRow({
  settingKey,
  label,
  description,
  currentValue,
  isDecayModel,
  history,
}: {
  settingKey: string;
  label: string;
  description: string;
  currentValue: string;
  isDecayModel: boolean;
  history: SettingHistoryEntry[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentValue);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const result = await updateSetting(settingKey, value, note);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setEditing(false);
    setNote("");
    router.refresh();
  }

  return (
    <li className="px-4 py-3">
      {/* The value + Change button stay pinned top-right regardless of how
          long the description runs — `min-w-0 flex-1` lets the text block
          take (and wrap within) the remaining width instead of pushing the
          controls onto their own left-aligned line. */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="font-medium">{label}</p>
          <p className="text-sm text-neutral-500">{description}</p>
          <code className="mt-1 inline-block text-xs text-neutral-600">{settingKey}</code>
        </div>
        {!editing && (
          <div className="flex shrink-0 items-center gap-3">
            <span className="font-mono text-lg">{currentValue}</span>
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
              Change
            </Button>
          </div>
        )}
      </div>

      {editing && (
        <form onSubmit={onSubmit} className="mt-3 flex flex-wrap items-end gap-3 rounded-md border border-border bg-neutral-900/40 p-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-400">New value</span>
            {isDecayModel ? (
              <select value={value} onChange={(e) => setValue(e.target.value)} className={fieldClasses({ size: "sm" })}>
                <option value="legacy">legacy</option>
                <option value="global">global</option>
              </select>
            ) : (
              <input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                inputMode="decimal"
                className={fieldClasses({ size: "sm" })}
              />
            )}
          </label>
          <label className="flex flex-1 min-w-[200px] flex-col gap-1 text-sm">
            <span className="text-neutral-400">Note (optional)</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="why this change?"
              className={fieldClasses({ size: "sm" })}
            />
          </label>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setEditing(false);
              setValue(currentValue);
              setError(null);
            }}
          >
            Cancel
          </Button>
          {error && <p className="w-full text-sm text-red-400">{error}</p>}
        </form>
      )}

      {history.length > 0 && (
        <div className="mt-2">
          <button type="button" onClick={() => setShowHistory((s) => !s)} className="text-xs text-neutral-500 hover:text-neutral-300">
            {showHistory ? "Hide" : "Show"} history ({history.length})
          </button>
          {showHistory && (
            <ul className="mt-2 space-y-1 border-l border-border pl-3 text-xs text-neutral-500">
              {history.map((h, i) => (
                <li key={i}>
                  <span className="font-mono text-neutral-300">{h.value}</span> effective {h.effectiveFrom} — changed by{" "}
                  {h.changedByName ?? "seed import"} on {h.changedAt}
                  {h.note && <span className="italic"> — &ldquo;{h.note}&rdquo;</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}
