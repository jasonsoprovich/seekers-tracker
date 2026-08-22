"use client";

import { useMemo, useState } from "react";

import { requestClaim } from "@/app/(app)/characters/claim/actions";
import { Button } from "@/components/ui/Button";
import { fieldClasses } from "@/components/ui/Field";

export type ClaimRow = {
  id: number;
  name: string;
  className: string;
  raceName: string;
  level: number;
  charType: "main" | "alt" | "mule";
  alreadyPending: boolean;
};

function ClaimRowItem({ row }: { row: ClaimRow }) {
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(row.alreadyPending);

  async function submit() {
    setPending(true);
    setError(null);
    const result = await requestClaim(row.id, note);
    setPending(false);
    if (result?.error) {
      setError(result.error);
      return;
    }
    setSubmitted(true);
  }

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {row.name} <span className="text-sm font-normal text-neutral-500">{row.charType === "alt" ? "(Alt)" : "(Main)"}</span>
          </p>
          <p className="text-sm text-neutral-400">
            Level {row.level} {row.className} — {row.raceName}
          </p>
        </div>
        {submitted ? (
          <span className="shrink-0 text-sm text-neutral-500">Pending officer review</span>
        ) : (
          <div className="flex shrink-0 items-center gap-2">
            <input
              type="text"
              placeholder="Note for officers (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className={`${fieldClasses({ size: "sm" })} w-48`}
            />
            <Button type="button" size="sm" onClick={submit} disabled={pending}>
              {pending ? "Claiming…" : "Claim"}
            </Button>
          </div>
        )}
      </div>
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </li>
  );
}

export function ClaimCharacterList({ rows }: { rows: ClaimRow[] }) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(q));
  }, [rows, search]);

  return (
    <div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-400">Search</span>
        <input
          type="text"
          placeholder="Character name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={`${fieldClasses({ size: "sm" })} w-64`}
        />
      </label>

      <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
        {filtered.length === 0 ? (
          <li className="px-4 py-6 text-center text-neutral-500">No unclaimed characters match.</li>
        ) : (
          filtered.map((row) => <ClaimRowItem key={row.id} row={row} />)
        )}
      </ul>
    </div>
  );
}
