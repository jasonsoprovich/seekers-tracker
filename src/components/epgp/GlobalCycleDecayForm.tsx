"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { commitGlobalCycleDecayAction, previewDecayAction } from "@/app/(app)/epgp/decay/actions";
import { Button } from "@/components/ui/Button";
import { fieldClasses } from "@/components/ui/Field";
import type { DecayPreviewRow } from "@/lib/epgp/decay";

type Preview = { rows: DecayPreviewRow[]; totalEpDecay: number; totalGpDecay: number };
type Result = { decayEventId: number; epRows: number; gpRows: number };

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// PLAN.md §11 Phase 5 task 5.4 — the leader's cycle-decay button (§1c: "not
// cron, cycles shift a day or two"). Same rate -> preview -> confirm ->
// commit shape as ExpansionDecayForm, and shares its preview action (the
// math is identical); only the commit step differs, writing a
// global_cycle decay_events row via commitGlobalCycleDecayAction. Default
// rate is 10% per §1c's confirmed guild vote, but stays adjustable — the
// input is free text, not a fixed control, same as expansion decay's.
export function GlobalCycleDecayForm() {
  const router = useRouter();
  const [rate, setRate] = useState("0.10");
  const [effectiveDate, setEffectiveDate] = useState(todayIso());
  const [label, setLabel] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPreview(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setResult(null);
    const outcome = await previewDecayAction(rate, effectiveDate);
    setPending(false);
    if (outcome.error || !outcome.rows) {
      setError(outcome.error ?? "Preview failed.");
      setPreview(null);
      return;
    }
    setPreview({ rows: outcome.rows, totalEpDecay: outcome.totalEpDecay ?? 0, totalGpDecay: outcome.totalGpDecay ?? 0 });
  }

  async function onCommit() {
    if (!preview) return;
    if (
      !confirm(
        `Apply ${(Number(rate) * 100).toFixed(0)}% cycle decay to ${preview.rows.length} character(s) as of ${effectiveDate}? This compounds on top of every prior cycle decay and writes ledger rows immediately.`,
      )
    ) {
      return;
    }
    setPending(true);
    setError(null);
    const outcome = await commitGlobalCycleDecayAction(rate, effectiveDate, label);
    setPending(false);
    if (outcome.error || outcome.decayEventId === undefined) {
      setError(outcome.error ?? "Commit failed.");
      return;
    }
    setResult({ decayEventId: outcome.decayEventId, epRows: outcome.epRows ?? 0, gpRows: outcome.gpRows ?? 0 });
    setPreview(null);
    router.refresh();
  }

  return (
    <div className="rounded-lg border border-border p-4">
      <form onSubmit={onPreview} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Rate (0–1)</span>
          <input
            value={rate}
            onChange={(e) => {
              setRate(e.target.value);
              setPreview(null);
              setResult(null);
            }}
            inputMode="decimal"
            className={`w-28 ${fieldClasses({ size: "sm" })}`}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Effective date</span>
          <input
            type="date"
            value={effectiveDate}
            onChange={(e) => {
              setEffectiveDate(e.target.value);
              setPreview(null);
              setResult(null);
            }}
            className={fieldClasses({ size: "sm" })}
          />
        </label>
        <label className="flex flex-1 min-w-[200px] flex-col gap-1 text-sm">
          <span className="text-neutral-400">Label (optional)</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Cycle 73 decay"
            className={fieldClasses({ size: "sm" })}
          />
        </label>
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending ? "Loading…" : "Preview"}
        </Button>
      </form>

      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

      {result && (
        <p className="mt-4 rounded-md border border-emerald-800 bg-emerald-950/40 p-3 text-sm text-emerald-300">
          Applied — decay event #{result.decayEventId}: {result.epRows} EP row(s), {result.gpRows} GP row(s) written.
        </p>
      )}

      {preview && (
        <div className="mt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-neutral-400">
              {preview.rows.length} character(s) affected — total EP decay {preview.totalEpDecay.toFixed(2)}, total GP decay{" "}
              {preview.totalGpDecay.toFixed(2)}.
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
                    <th className="px-3 py-2 text-right">EP balance</th>
                    <th className="px-3 py-2 text-right">EP decay</th>
                    <th className="px-3 py-2 text-right">GP balance</th>
                    <th className="px-3 py-2 text-right">GP decay</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr key={row.characterId} className="border-t border-border/60">
                      <td className="px-3 py-1.5">{row.characterName}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{row.epBalance.toFixed(2)}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-red-400">{row.epDecay > 0 ? `-${row.epDecay.toFixed(2)}` : "—"}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{row.gpBalance.toFixed(2)}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-red-400">{row.gpDecay > 0 ? `-${row.gpDecay.toFixed(2)}` : "—"}</td>
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
