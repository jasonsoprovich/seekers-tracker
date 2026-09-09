"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { claimAlt } from "@/app/(app)/characters/actions";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { fieldClasses } from "@/components/ui/Field";

export type LinkAltRow = {
  id: number;
  name: string;
  className: string;
  raceName: string;
  level: number;
  charType: "main" | "alt" | "mule";
};

// post-live-test-1 LT-31 — one-click "link this unclaimed character to my
// main as an alt", no officer approval (contrast /characters/claim, which
// files an officer request for contested / not-yet-owned mains). Renders
// only when the viewer has a main (page passes `mainName`).
export function LinkAltsPanel({ mainName, rows }: { mainName: string; rows: LinkAltRow[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [done, setDone] = useState<Set<number>>(new Set());
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [errors, setErrors] = useState<Record<number, string>>({});

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = rows.filter((r) => !done.has(r.id));
    if (!q) return base.slice(0, 40);
    return base.filter((r) => r.name.toLowerCase().includes(q));
  }, [rows, search, done]);

  const remaining = rows.length - done.size;
  const truncated = !search.trim() && remaining > filtered.length;

  async function link(id: number) {
    setPendingId(id);
    setErrors((e) => {
      const next = { ...e };
      delete next[id];
      return next;
    });
    const result = await claimAlt(id);
    setPendingId(null);
    if (result?.error) {
      setErrors((e) => ({ ...e, [id]: result.error! }));
      return;
    }
    setDone((d) => new Set(d).add(id));
    router.refresh();
  }

  return (
    <Card className="mt-8 px-4 py-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-left"
      >
        <span>
          <span className="font-medium text-neutral-100">Link an alt to {mainName}</span>
          <span className="ml-2 text-sm text-neutral-500">{remaining} unclaimed characters</span>
        </span>
        <span className="text-neutral-500">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="mt-3">
          <p className="text-sm text-neutral-400">
            Attaches an unclaimed roster character to your account as an alt of {mainName}, right away — its EP/GP history
            comes with it. To claim a character another member owns, or your own main,{" "}
            <Link href="/characters/claim" className="text-emerald-400 hover:text-emerald-300">
              file a claim
            </Link>{" "}
            instead.
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
                      <p className="font-medium">
                        {row.name}{" "}
                        <span className="text-sm font-normal text-neutral-500">
                          {row.charType === "alt" ? "(Alt)" : row.charType === "mule" ? "(Mule)" : "(Main)"}
                        </span>
                      </p>
                      <p className="text-sm text-neutral-400">
                        Level {row.level} {row.className} — {row.raceName}
                      </p>
                    </div>
                    <Button type="button" size="sm" onClick={() => link(row.id)} disabled={pendingId === row.id}>
                      {pendingId === row.id ? "Linking…" : "Link as alt"}
                    </Button>
                  </div>
                  {errors[row.id] && <p className="mt-1 text-xs text-red-400">{errors[row.id]}</p>}
                </li>
              ))
            )}
          </ul>
          {truncated && (
            <p className="mt-2 text-xs text-neutral-500">
              Showing the first {filtered.length}. Search to find a specific character.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
