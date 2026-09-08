import { redirect } from "next/navigation";

import { RaidsList } from "@/components/epgp/RaidsList";
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
        <RaidsList rows={rows} />
      )}
    </div>
  );
}
