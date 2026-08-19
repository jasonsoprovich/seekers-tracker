import { desc, eq, like, or } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/shell/PageHeader";
import { fieldClasses } from "@/components/ui/Field";
import { characters, epLedger, gpLedger } from "@/db";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";

const PAGE_SIZE = 50;

type SearchParams = { type?: string; q?: string; page?: string };

// The EP/GP Log tabs this replaces (47k/5.9k rows) — the first paginated
// list in the app (see the EPGP plan: everything else loads its whole
// table client-side, but that doesn't scale to tens of thousands of ledger
// rows). Plain GET-form + limit/offset rather than client-side state, to
// match this repo's server-component-first convention elsewhere.
export default async function EpgpLedgerPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { type: typeParam, q = "", page: pageParam } = await searchParams;
  const type = typeParam === "gp" ? "gp" : "ep";
  const page = Math.max(1, Number(pageParam) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const term = q.trim();

  const db = await getDb();

  const rows =
    type === "ep"
      ? await db
          .select({
            id: epLedger.id,
            characterName: characters.name,
            occurredAt: epLedger.occurredAt,
            activity: epLedger.activity,
            points: epLedger.points,
            note: epLedger.note,
            source: epLedger.source,
          })
          .from(epLedger)
          .innerJoin(characters, eq(epLedger.characterId, characters.id))
          .where(
            term
              ? or(like(characters.name, `%${term}%`), like(epLedger.activity, `%${term}%`))
              : undefined,
          )
          .orderBy(desc(epLedger.occurredAt))
          .limit(PAGE_SIZE + 1)
          .offset(offset)
      : await db
          .select({
            id: gpLedger.id,
            characterName: characters.name,
            occurredAt: gpLedger.occurredAt,
            itemName: gpLedger.itemName,
            tier: gpLedger.tier,
            points: gpLedger.points,
            duplicateFlag: gpLedger.duplicateFlag,
            source: gpLedger.source,
          })
          .from(gpLedger)
          .innerJoin(characters, eq(gpLedger.characterId, characters.id))
          .where(
            term
              ? or(like(characters.name, `%${term}%`), like(gpLedger.itemName, `%${term}%`), like(gpLedger.tier, `%${term}%`))
              : undefined,
          )
          .orderBy(desc(gpLedger.occurredAt))
          .limit(PAGE_SIZE + 1)
          .offset(offset)
  ;

  const hasNext = rows.length > PAGE_SIZE;
  const pageRows = rows.slice(0, PAGE_SIZE);

  function pageHref(overrides: { type?: string; q?: string; page?: number }) {
    const params = new URLSearchParams();
    params.set("type", overrides.type ?? type);
    if (overrides.q ?? term) params.set("q", overrides.q ?? term);
    params.set("page", String(overrides.page ?? page));
    return `/epgp/ledger?${params.toString()}`;
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="EPGP Ledger" subtitle="Raw EP and GP transaction history — every row that adds up to the standings on /roster." />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex gap-2">
          <Link
            href={pageHref({ type: "ep", page: 1 })}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${type === "ep" ? "bg-accent text-black" : "border border-field text-neutral-300 hover:bg-neutral-900/60"}`}
          >
            EP Log
          </Link>
          <Link
            href={pageHref({ type: "gp", page: 1 })}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${type === "gp" ? "bg-accent text-black" : "border border-field text-neutral-300 hover:bg-neutral-900/60"}`}
          >
            GP Log
          </Link>
        </div>

        <form method="get" className="flex items-end gap-2">
          <input type="hidden" name="type" value={type} />
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-400">Search</span>
            <input
              type="text"
              name="q"
              defaultValue={term}
              placeholder={type === "ep" ? "Character or activity…" : "Character, item, or tier…"}
              className={`${fieldClasses({ size: "sm" })} w-56`}
            />
          </label>
          <button type="submit" className="rounded-md border border-field px-3 py-1.5 text-sm font-medium text-neutral-300 hover:bg-neutral-900/60">
            Search
          </button>
        </form>
      </div>

      <div className="mt-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Character</th>
              {type === "ep" ? (
                <th className="px-3 py-2 font-medium">Activity</th>
              ) : (
                <>
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 font-medium">Tier</th>
                </>
              )}
              <th className="px-3 py-2 font-medium">Points</th>
              <th className="px-3 py-2 font-medium">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {pageRows.map((r) => (
              <tr key={r.id} className="hover:bg-neutral-900/40">
                <td className="px-3 py-2 text-neutral-400">{r.occurredAt.toLocaleDateString()}</td>
                <td className="px-3 py-2 font-medium">{r.characterName}</td>
                {type === "ep" && "activity" in r ? (
                  <td className="px-3 py-2 text-neutral-400">{r.activity}</td>
                ) : (
                  "itemName" in r && (
                    <>
                      <td className="px-3 py-2 text-neutral-400">{r.itemName ?? "—"}</td>
                      <td className="px-3 py-2 text-neutral-400">{r.tier}</td>
                    </>
                  )
                )}
                <td className={`px-3 py-2 font-medium ${r.points < 0 ? "text-red-400" : "text-emerald-400"}`}>{r.points}</td>
                <td className="px-3 py-2 text-neutral-500">{r.source}</td>
              </tr>
            ))}
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-neutral-500">
                  No rows match this search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center justify-between text-sm">
        <span className="text-neutral-500">Page {page}</span>
        <div className="flex gap-2">
          {page > 1 && (
            <Link href={pageHref({ page: page - 1 })} className="rounded-md border border-field px-3 py-1.5 font-medium text-neutral-300 hover:bg-neutral-900/60">
              ← Prev
            </Link>
          )}
          {hasNext && (
            <Link href={pageHref({ page: page + 1 })} className="rounded-md border border-field px-3 py-1.5 font-medium text-neutral-300 hover:bg-neutral-900/60">
              Next →
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
