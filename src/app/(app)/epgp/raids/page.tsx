import Link from "next/link";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/shell/PageHeader";
import { getDb } from "@/lib/db";
import { listRaids } from "@/lib/epgp/raids";
import { getSession } from "@/lib/session";

// Every raid night, newest first — derived by grouping parse-sourced
// attendance + loot by guild-local (Eastern) date (src/lib/epgp/raids.ts,
// src/lib/guild-timezone.ts). Read-only for everyone; officers name a
// night on its detail page. Visible to every role, same as the rest of
// /epgp.
export default async function RaidsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const rows = await listRaids(db);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Raids & Events" subtitle="Every attendance capture and loot event, grouped by night." />

      {rows.length === 0 ? (
        <div className="rounded-lg border border-border px-3 py-6 text-center text-sm text-neutral-500">
          No raids recorded yet — they appear here once an officer submits an attendance capture.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-[11px] uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Zone(s)</th>
                <th className="px-3 py-2 font-medium text-right">Attended</th>
                <th className="px-3 py-2 font-medium text-right">Items</th>
                <th className="px-3 py-2 font-medium text-right">EP awarded</th>
                <th className="px-3 py-2 font-medium text-right">GP spent</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.raidDate} className="hover:bg-neutral-900/40">
                  <td className="px-3 py-2 whitespace-nowrap">
                    <Link href={`/epgp/raids/${r.raidDate}`} className="font-medium text-emerald-400 hover:text-emerald-300">
                      {r.raidDate}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{r.name ?? <span className="text-neutral-600">—</span>}</td>
                  <td className="px-3 py-2 text-neutral-400">{r.zones.length ? r.zones.join(", ") : "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.memberCount}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.itemCount}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{Math.round(r.epAwarded)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{Math.round(r.gpSpent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
