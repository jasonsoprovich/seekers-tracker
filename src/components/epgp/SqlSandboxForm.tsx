"use client";

import { useActionState } from "react";

import { runEpgpQuery, type SqlQueryResult } from "@/app/(app)/epgp/sql/actions";
import { Button } from "@/components/ui/Button";
import { fieldClasses } from "@/components/ui/Field";

const EXAMPLE = "SELECT name, class, level FROM v_characters ORDER BY level DESC LIMIT 20";

export function SqlSandboxForm() {
  const [state, formAction, pending] = useActionState<SqlQueryResult, FormData>(runEpgpQuery, {});

  return (
    <div>
      <form action={formAction} className="flex flex-col gap-2">
        <textarea
          name="query"
          rows={5}
          required
          defaultValue={state.query ?? EXAMPLE}
          placeholder={EXAMPLE}
          className={`${fieldClasses({ mono: true })} resize-y`}
        />
        <div className="flex items-center gap-3">
          <Button type="submit" size="md" disabled={pending}>
            {pending ? "Running…" : "Run query"}
          </Button>
          <span className="text-xs text-neutral-500">Read-only SELECT against the v_-prefixed EPGP views, capped at 200 rows.</span>
        </div>
      </form>

      {state.error && <p className="mt-4 text-sm text-red-400">{state.error}</p>}

      {state.columns && state.rows && (
        <div className="mt-4 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[480px] text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
                {state.columns.map((c) => (
                  <th key={c} className="px-3 py-2 font-medium">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {state.rows.map((row, i) => (
                <tr key={i} className="hover:bg-neutral-900/40">
                  {state.columns!.map((c) => (
                    <td key={c} className="px-3 py-2 text-neutral-300">
                      {row[c] === null ? <span className="text-neutral-600">NULL</span> : String(row[c])}
                    </td>
                  ))}
                </tr>
              ))}
              {state.rows.length === 0 && (
                <tr>
                  <td colSpan={state.columns.length} className="px-3 py-6 text-center text-neutral-500">
                    No rows returned.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="px-3 py-2 text-xs text-neutral-500">{state.rows.length} row{state.rows.length === 1 ? "" : "s"} (capped at 200).</p>
        </div>
      )}
    </div>
  );
}
