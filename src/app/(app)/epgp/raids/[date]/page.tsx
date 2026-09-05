import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { RaidNameEditor } from "@/components/epgp/RaidNameEditor";
import { PageHeader } from "@/components/shell/PageHeader";
import { canManageEpgp, getUserRole } from "@/lib/authz";
import { users } from "@/db";
import { getDb } from "@/lib/db";
import { getRaidDetail } from "@/lib/epgp/raids";
import { GUILD_TIMEZONE } from "@/lib/guild-timezone";
import { getSession } from "@/lib/session";

// The page groups by guild-local (Eastern) calendar date (raids.ts) —
// showing UTC times right next to that date read as a mismatch (e.g. a
// "00:01 UTC" entry under a raid dated the evening before). Times are
// formatted in the *viewer's* own timezone preference if they've set one
// (profile page, users.timezone), else the guild default — the grouping
// itself always stays guild-wide regardless (see schema.ts's comment).
function localTimeFormatterFor(timeZone: string) {
  const timeFormatter = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit" });
  const tzAbbrevFormatter = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" });
  return (d: Date): string => {
    const tz = tzAbbrevFormatter.formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? timeZone;
    return `${timeFormatter.format(d)} ${tz}`;
  };
}

export default async function RaidDetailPage({ params }: { params: Promise<{ date: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { date } = await params;
  const db = await getDb();
  const [detail, [me]] = await Promise.all([
    getRaidDetail(db, date),
    db.select({ timezone: users.timezone }).from(users).where(eq(users.id, session.user.id)),
  ]);
  if (!detail) notFound();

  const canManage = canManageEpgp(await getUserRole(session.user.id));
  const timeLocal = localTimeFormatterFor(me?.timezone || GUILD_TIMEZONE);

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
                  {timeLocal(c.occurredAt)}
                  {c.zone ? ` · ${c.zone}` : ""} · {c.members.length} member{c.members.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 px-3 py-2 text-sm">
                {c.members.map((m, j) => (
                  <span key={j} className="text-neutral-300">
                    {m.name}
                    <span className={`ml-1 font-mono text-xs ${m.ep >= 0 ? "text-emerald-400/80" : "text-red-400/80"}`}>
                      {m.ep >= 0 ? "+" : ""}
                      {m.ep} EP
                    </span>
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
                  <td className="px-3 py-2 tabular-nums text-neutral-400">{timeLocal(l.occurredAt)}</td>
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
