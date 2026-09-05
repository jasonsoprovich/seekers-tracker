import { ledgerDate } from "@/lib/format-date";
import type { TotalsRow } from "@/lib/epgp/ledger-list";

// Mirrors the guild sheet's own Totals tab: one row per player (main
// character name — alt/mule activity is already rolled into these numbers,
// see getTotalsRows), last activity, EP, GP, priority.
export function TotalsTable({ rows }: { rows: TotalsRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[820px] text-left text-sm">
        <thead>
          <tr className="border-b border-border bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
            <th className="px-3 py-2 font-medium">Main</th>
            <th className="px-3 py-2 font-medium">Last activity</th>
            <th className="px-3 py-2 text-right font-medium">EP</th>
            <th className="px-3 py-2 text-right font-medium">EP Decay</th>
            <th className="px-3 py-2 text-right font-medium">GP</th>
            <th className="px-3 py-2 text-right font-medium">GP Decay</th>
            <th className="px-3 py-2 text-right font-medium">Priority</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.playerId} className="hover:bg-neutral-900/40">
              <td className="px-3 py-2 font-medium">
                {r.mainCharacterName}
                {r.playerStatus !== "active" && (
                  <span className="ml-2 rounded-full bg-neutral-700/40 px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-400">
                    {r.playerStatus}
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-neutral-400">{r.lastActivityAt ? ledgerDate(r.lastActivityAt) : "—"}</td>
              <td className="px-3 py-2 text-right tabular-nums">{Math.round(r.ep)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-neutral-500">{r.epDecay > 0 ? `-${Math.round(r.epDecay)}` : "—"}</td>
              <td className="px-3 py-2 text-right tabular-nums">{Math.round(r.gp)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-neutral-500">{r.gpDecay > 0 ? `-${Math.round(r.gpDecay)}` : "—"}</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-emerald-400">{r.priorityRating.toFixed(4)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-6 text-center text-neutral-500">
                No players with a resolved main character yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
