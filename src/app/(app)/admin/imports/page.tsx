import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/shell/PageHeader";
import { characters, importLog, users } from "@/db";
import { canManageAnyCharacter, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";

const KIND_LABELS: Record<string, string> = {
  seer_text: "Seer Text",
  pqc_export: "pq-companion Export",
  gear_export: "Gear Export",
};

// Officer/leader audit trail (§6/§9 task 17): every import, most recent
// first, with a link through to the raw payload for imports that archived
// one — see src/lib/import-archive.ts.
export default async function ImportAuditTrailPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);
  if (!canManageAnyCharacter(role)) redirect("/characters");

  const db = await getDb();
  const rows = await db
    .select({
      id: importLog.id,
      kind: importLog.kind,
      summary: importLog.summary,
      r2Key: importLog.r2Key,
      createdAt: importLog.createdAt,
      characterId: importLog.characterId,
      characterName: characters.name,
      uploaderUsername: users.username,
    })
    .from(importLog)
    .innerJoin(characters, eq(importLog.characterId, characters.id))
    .innerJoin(users, eq(importLog.uploadedBy, users.id))
    .orderBy(desc(importLog.createdAt))
    .limit(200);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        breadcrumbs={[{ label: "Admin", href: "/admin" }, { label: "Import Audit Trail" }]}
        title="Import Audit Trail"
        subtitle={`Last ${rows.length} import${rows.length === 1 ? "" : "s"}, most recent first.`}
      />

      {rows.length === 0 ? (
        <p className="text-neutral-400">No imports yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  <Link href={`/characters/${r.characterId}`} className="hover:text-emerald-400">
                    {r.characterName}
                  </Link>{" "}
                  <span className="text-sm font-normal text-neutral-500">
                    {KIND_LABELS[r.kind] ?? r.kind} — {r.uploaderUsername}
                  </span>
                </p>
                <p className="mt-0.5 truncate text-sm text-neutral-400">{r.summary}</p>
              </div>
              <div className="flex shrink-0 items-center gap-4 text-sm">
                <span className="text-neutral-500 tabular-nums">
                  {r.createdAt.toLocaleDateString()} {r.createdAt.toLocaleTimeString()}
                </span>
                {r.r2Key ? (
                  <Link href={`/admin/imports/${r.id}`} className="font-medium text-emerald-400 hover:text-emerald-300">
                    View payload
                  </Link>
                ) : (
                  <span className="text-neutral-600">no payload</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
