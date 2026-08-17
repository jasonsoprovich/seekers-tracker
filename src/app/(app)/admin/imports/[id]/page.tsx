import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";

import { PageHeader } from "@/components/shell/PageHeader";
import { characters, importLog, users } from "@/db";
import { canManageAnyCharacter, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { readImportPayload } from "@/lib/import-archive";
import { getSession } from "@/lib/session";

const KIND_LABELS: Record<string, string> = {
  seer_text: "Seer Text",
  pqc_export: "pq-companion Export",
  gear_export: "Gear Export",
};

export default async function ImportPayloadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const importId = Number(id);
  if (!Number.isInteger(importId)) notFound();

  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);
  if (!canManageAnyCharacter(role)) redirect("/characters");

  const db = await getDb();
  const [row] = await db
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
    .where(eq(importLog.id, importId));
  if (!row) notFound();

  const payload = row.r2Key ? await readImportPayload(row.r2Key) : null;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        breadcrumbs={[
          { label: "Admin", href: "/admin" },
          { label: "Import Audit Trail", href: "/admin/imports" },
          { label: row.characterName },
        ]}
        title={`${KIND_LABELS[row.kind] ?? row.kind} — ${row.characterName}`}
        subtitle={
          <>
            Submitted by {row.uploaderUsername} on {row.createdAt.toLocaleString()}
            <br />
            {row.summary}
          </>
        }
      />

      {payload === null ? (
        <p className="text-sm text-neutral-500 italic">
          {row.r2Key ? "This payload could not be loaded from the archive." : "No payload was archived for this import."}
        </p>
      ) : (
        <pre className="max-h-[70vh] overflow-auto rounded-lg border border-border bg-panel p-4 text-xs whitespace-pre-wrap text-neutral-200">
          {payload}
        </pre>
      )}
    </div>
  );
}
