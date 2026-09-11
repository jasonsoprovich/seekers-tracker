"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { linkCharacterToAccount } from "@/app/(app)/characters/[id]/account/actions";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { fieldClasses } from "@/components/ui/Field";

export type LinkCandidate = {
  id: number;
  name: string;
  className: string;
  raceName: string;
  level: number;
  charType: "main" | "alt" | "mule";
};

// "Link a character to this account" — same shape as LinkAltsPanel (the
// self-service version on /characters), but targeted at a specific
// account so an officer can build out another member's group, and an
// unclaimed account can be managed at all.
export function LinkToAccountPanel({ playerId, accountName, rows }: { playerId: number; accountName: string; rows: LinkCandidate[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [done, setDone] = useState<Set<number>>(new Set());
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [errors, setErrors] = useState<Record<number, string>>({});

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = rows.filter((r) => !done.has(r.id));
    if (!q) return base.slice(0, 30);
    return base.filter((r) => r.name.toLowerCase().includes(q)).slice(0, 60);
  }, [rows, search, done]);

  const remaining = rows.length - done.size;

  async function link(id: number) {
    setPendingId(id);
    setErrors((e) => {
      const next = { ...e };
      delete next[id];
      return next;
    });
    const result = await linkCharacterToAccount(playerId, id);
    setPendingId(null);
    if (result.error) {
      setErrors((e) => ({ ...e, [id]: result.error! }));
      return;
    }
    setDone((d) => new Set(d).add(id));
    router.refresh();
  }

  return (
    <Card className="mt-6 px-4 py-3">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between text-left">
        <span>
          <span className="font-medium text-neutral-100">Link a character to {accountName}</span>
          <span className="ml-2 text-sm text-neutral-500">{remaining} unclaimed</span>
        </span>
        <span className="text-neutral-500">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="mt-3">
          <p className="text-sm text-neutral-400">
            Only unclaimed roster characters are listed. A character with its own EP/GP history brings that history to this account.
            A character already on another member&apos;s account has to be unlinked there first.
          </p>
          <label className="mt-3 flex flex-col gap-1 text-sm">
            <span className="text-neutral-400">Search</span>
            <input
              type="text"
              placeholder="Character name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={`${fieldClasses({ size: "sm" })} w-64`}
            />
          </label>
          <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
            {filtered.length === 0 ? (
              <li className="px-4 py-6 text-center text-neutral-500">
                {search.trim() ? "No unclaimed characters match." : "No unclaimed characters."}
              </li>
            ) : (
              filtered.map((row) => (
                <li key={row.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{row.name}</p>
                      <p className="text-sm text-neutral-400">
                        Level {row.level} {row.className} — {row.raceName}
                      </p>
                    </div>
                    <Button type="button" size="sm" onClick={() => link(row.id)} disabled={pendingId === row.id}>
                      {pendingId === row.id ? "Linking…" : "Link to account"}
                    </Button>
                  </div>
                  {errors[row.id] && <p className="mt-1 text-xs text-red-400">{errors[row.id]}</p>}
                </li>
              ))
            )}
          </ul>
          {!search.trim() && remaining > filtered.length && (
            <p className="mt-2 text-xs text-neutral-500">Showing the first {filtered.length}. Search to find a specific character.</p>
          )}
        </div>
      )}
    </Card>
  );
}
