"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { addLedgerEntry } from "@/app/(app)/epgp/ledger/actions";
import { Button } from "@/components/ui/Button";
import { Field, fieldClasses } from "@/components/ui/Field";

type CharacterOption = { id: number; name: string };

function todayInputValue() {
  return new Date().toISOString().slice(0, 10);
}

export function AddLedgerEntryForm({
  type,
  characters,
  activitySuggestions,
  itemSuggestions,
}: {
  type: "ep" | "gp";
  characters: CharacterOption[];
  activitySuggestions: string[];
  itemSuggestions: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const characterId = Number(formData.get("characterId"));
    const activityOrTier = String(formData.get("activityOrTier") ?? "");
    const itemName = String(formData.get("itemName") ?? "");
    const points = Number(formData.get("points"));
    const occurredAt = String(formData.get("occurredAt") ?? "");
    const note = String(formData.get("note") ?? "");

    setPending(true);
    setError(null);
    const result = await addLedgerEntry(
      type === "ep"
        ? { kind: "ep", characterId, activity: activityOrTier, points, occurredAt, note }
        : { kind: "gp", characterId, tier: activityOrTier, itemName, points, occurredAt, note },
    );
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        + Add {type === "ep" ? "EP" : "GP"} entry
      </Button>
    );
  }

  return (
    <form onSubmit={onSubmit} className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-field bg-neutral-900/40 p-3">
      <Field className="w-48">
        <span className="text-neutral-400">Character</span>
        <select name="characterId" defaultValue={characters[0]?.id} className={fieldClasses({ size: "sm" })}>
          {characters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>

      {type === "gp" && (
        <Field className="w-40">
          <span className="text-neutral-400">Item</span>
          <input name="itemName" list="gp-item-suggestions" className={fieldClasses({ size: "sm" })} placeholder="Optional" />
          <datalist id="gp-item-suggestions">
            {itemSuggestions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </Field>
      )}

      <Field className="w-48">
        <span className="text-neutral-400">{type === "ep" ? "Activity" : "Tier"}</span>
        <input
          name="activityOrTier"
          list={`${type}-activity-suggestions`}
          required
          className={fieldClasses({ size: "sm" })}
          placeholder={type === "ep" ? "e.g. Bank Donation" : "e.g. High Bid"}
        />
        <datalist id={`${type}-activity-suggestions`}>
          {activitySuggestions.map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
      </Field>

      <Field className="w-24">
        <span className="text-neutral-400">Points</span>
        <input name="points" inputMode="decimal" required className={fieldClasses({ size: "sm" })} />
      </Field>

      <Field className="w-40">
        <span className="text-neutral-400">Date</span>
        <input type="date" name="occurredAt" defaultValue={todayInputValue()} required className={fieldClasses({ size: "sm" })} />
      </Field>

      <Field className="w-56">
        <span className="text-neutral-400">Note</span>
        <input name="note" className={fieldClasses({ size: "sm" })} placeholder="Optional" />
      </Field>

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Adding…" : "Add"}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
      </div>

      {error && <p className="w-full text-sm text-red-400">{error}</p>}
    </form>
  );
}
