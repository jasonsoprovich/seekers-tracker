"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { commitDepartureAction, previewDepartureAction } from "@/app/(app)/epgp/decay/actions";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { fieldClasses } from "@/components/ui/Field";
import type { DeparturePreviewRow } from "@/lib/epgp/decay";

type Preview = { rows: DeparturePreviewRow[]; totalEp: number };
type Result = { decayEventId: number; epRows: number };

// PLAN.md §11 Phase 2 tasks 2.9-2.12 (§1f) — search by name and/or an
// inactive-since date -> preview (who, current EP) -> confirm -> result.
// GP is never touched or shown as affected here (§1e's asymmetry).
export function DepartureWipeForm() {
  const router = useRouter();
  const confirm = useConfirm();
  const [names, setNames] = useState("");
  const [inactiveSince, setInactiveSince] = useState("");
  const [label, setLabel] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetOutputs() {
    setPreview(null);
    setResult(null);
    setUnmatched([]);
  }

  async function onPreview(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setResult(null);
    const outcome = await previewDepartureAction(names, inactiveSince);
    setPending(false);
    setUnmatched(outcome.unmatchedNames ?? []);
    if (outcome.error || !outcome.rows) {
      setError(outcome.error ?? "Preview failed.");
      setPreview(null);
      return;
    }
    setPreview({ rows: outcome.rows, totalEp: outcome.totalEp ?? 0 });
  }

  async function onCommit() {
    if (!preview) return;
    const ok = await confirm({
      title: "Zero EP for departure?",
      message: `Zero the EP of ${preview.rows.length} character(s)? GP is not affected. This writes ledger rows immediately.`,
      confirmLabel: "Zero EP",
      danger: true,
    });
    if (!ok) return;
    setPending(true);
    setError(null);
    const outcome = await commitDepartureAction(names, inactiveSince, label);
    setPending(false);
    setUnmatched(outcome.unmatchedNames ?? []);
    if (outcome.error || outcome.decayEventId === undefined) {
      setError(outcome.error ?? "Commit failed.");
      return;
    }
    setResult({ decayEventId: outcome.decayEventId, epRows: outcome.epRows ?? 0 });
    setPreview(null);
    router.refresh();
  }

  return (
    <div className="rounded-lg border border-border p-4">
      <form onSubmit={onPreview} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Character names (comma or newline separated — takes priority over the date below)</span>
          <textarea
            value={names}
            onChange={(e) => {
              setNames(e.target.value);
              resetOutputs();
            }}
            rows={2}
            placeholder="e.g. Aylah, Beguilez"
            className={fieldClasses({ size: "sm" })}
          />
        </label>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-400">Inactive since (no EP earned on/after this date)</span>
            <input
              type="date"
              value={inactiveSince}
              onChange={(e) => {
                setInactiveSince(e.target.value);
                resetOutputs();
              }}
              className={fieldClasses({ size: "sm" })}
            />
          </label>
          <label className="flex flex-1 min-w-[200px] flex-col gap-1 text-sm">
            <span className="text-neutral-400">Label (optional)</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. inactive since Velious launch"
              className={fieldClasses({ size: "sm" })}
            />
          </label>
          <Button type="submit" size="sm" variant="outline" disabled={pending}>
            {pending ? "Loading…" : "Preview"}
          </Button>
        </div>
      </form>

      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      {unmatched.length > 0 && <p className="mt-2 text-sm text-amber-400">No character found named: {unmatched.join(", ")}</p>}

      {result && (
        <p className="mt-4 rounded-md border border-emerald-800 bg-emerald-950/40 p-3 text-sm text-emerald-300">
          Applied — decay event #{result.decayEventId}: {result.epRows} character(s) had EP zeroed.
        </p>
      )}

      {preview && (
        <div className="mt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-neutral-400">
              {preview.rows.length} character(s) matched — total EP to be zeroed {preview.totalEp.toFixed(2)}. GP is not affected.
            </p>
            <Button type="button" size="sm" onClick={onCommit} disabled={pending || preview.rows.length === 0}>
              {pending ? "Committing…" : "Confirm & commit"}
            </Button>
          </div>

          {preview.rows.length > 0 && (
            <div className="mt-3 max-h-96 overflow-y-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-neutral-900 text-left text-neutral-500">
                  <tr>
                    <th className="px-3 py-2">Character</th>
                    <th className="px-3 py-2 text-right">Current EP</th>
                    <th className="px-3 py-2">Last EP activity</th>
                    <th className="px-3 py-2 text-right">GP (unaffected)</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr key={row.characterId} className="border-t border-border/60">
                      <td className="px-3 py-1.5">{row.characterName}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-red-400">-{row.epBalance.toFixed(2)}</td>
                      <td className="px-3 py-1.5 text-neutral-500">{row.lastEpActivity ? new Date(row.lastEpActivity).toLocaleDateString() : "never"}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-neutral-500">{row.gpBalance.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
