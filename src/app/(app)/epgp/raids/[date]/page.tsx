import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { RaidNameEditor } from "@/components/epgp/RaidNameEditor";
import { PageHeader } from "@/components/shell/PageHeader";
import { canManageEpgp, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { getRaidDetail } from "@/lib/epgp/raids";
import { getSession } from "@/lib/session";

function timeUTC(d: Date): string {
  return d.toISOString().slice(11, 16) + " UTC";
}

export default async function RaidDetailPage({ params }: { params: Promise<{ date: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { date } = await params;
  const db = await getDb();
  const detail = await getRaidDetail(db, date);
  if (!detail) notFound();

  const canManage = canManageEpgp(await getUserRole(session.user.id));

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        breadcrumbs={[
          { label: "Raids & Events", href: "/epgp/raids" },
          { label: detail.raidDate },
        ]}
        title={detail.name ? `${detail.name} — ${detail.raidDate}` : detail.raidDate}
      />

      {canManage ? (
        <RaidNameEditor raidDate={detail.raidDate} name={detail.name} note={detail.note} />
      ) : (
        detail.note && <p className="text-sm text-neutral-500">{detail.note}</p>
      )}

      <div className="mt-4 flex flex-wrap gap-4 text-sm">
        <span className="rounded-md border border-border px-3 py-1.5">
          <span className="text-neutral-500">Attended</span> <span className="font-semibold">{detail.memberCount}</span>
        </span>
        <span className="rounded-md border border-border px-3 py-1.5">
          <span className="text-neutral-500">EP awarded</span> <span className="font-semibold">{Math.round(detail.epAwarded)}</span>
        </span>
        <span className="rounded-md border border-border px-3 py-1.5">
          <span className="text-neutral-500">GP spent</span> <span className="font-semibold">{Math.round(detail.gpSpent)}</span>
        </span>
        <span className="rounded-md border border-border px-3 py-1.5">
          <span className="text-neutral-500">Items</span> <span className="font-semibold">{detail.loot.length}</span>
        </span>
      </div>

      <h2 className="mt-8 text-lg font-semibold">Attendance</h2>
      {detail.captures.length === 0 ? (
        <p className="mt-1 text-sm text-neutral-500">No attendance captures on this date.</p>
      ) : (
        <div className="mt-3 space-y-4">
          {detail.captures.map((c, i) => (
            <div key={i} className="rounded-lg border border-border">
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-3 py-2 text-sm">
                <span className="font-medium">{c.activity}</span>
                <span className="text-neutral-500">
                  {timeUTC(c.occurredAt)}
                  {c.zone ? ` · ${c.zone}` : ""} · {c.members.length} member{c.members.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 px-3 py-2 text-sm">
                {c.members.map((m, j) => (
                  <span key={j} className="text-neutral-300">
                    {m.name}
                    {m.priority !== null && <span className="ml-1 font-mono text-xs text-emerald-400/80">{m.priority.toFixed(4)}</span>}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <h2 className="mt-8 text-lg font-semibold">Loot</h2>
      {detail.loot.length === 0 ? (
        <p className="mt-1 text-sm text-neutral-500">No loot events on this date.</p>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-[11px] uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-3 py-2 font-medium">Item</th>
                <th className="px-3 py-2 font-medium">Winner</th>
                <th className="px-3 py-2 font-medium">Bid</th>
                <th className="px-3 py-2 font-medium text-right">GP</th>
                <th className="px-3 py-2 font-medium">Time</th>
                <th className="px-3 py-2 font-medium">Note</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {detail.loot.map((l, i) => (
                <tr key={i}>
                  <td className="px-3 py-2 font-medium">{l.itemName}</td>
                  <td className="px-3 py-2">{l.winnerName ?? <span className="text-neutral-600">—</span>}</td>
                  <td className="px-3 py-2 text-neutral-400">{l.tier ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{l.gp !== null ? Math.round(l.gp) : "—"}</td>
                  <td className="px-3 py-2 tabular-nums text-neutral-400">{timeUTC(l.occurredAt)}</td>
                  <td className="px-3 py-2 text-neutral-500">{l.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-6 text-sm">
        <Link href="/epgp/raids" className="text-emerald-400 hover:text-emerald-300">
          ← All raids
        </Link>
      </p>
    </div>
  );
}
