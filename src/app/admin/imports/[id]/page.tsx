import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

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
    <div className="min-h-screen bg-neutral-950 px-6 py-10 text-neutral-100">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">
            {KIND_LABELS[row.kind] ?? row.kind} — {row.characterName}
          </h1>
          <Link href="/admin/imports" className="text-sm font-medium text-neutral-400 hover:text-neutral-300">
            Back
          </Link>
        </div>
        <p className="mt-1 text-sm text-neutral-400">
          Submitted by {row.uploaderUsername} on {row.createdAt.toLocaleString()}
        </p>
        <p className="mt-1 text-sm text-neutral-400">{row.summary}</p>

        <div className="mt-6">
          {payload === null ? (
            <p className="text-sm text-neutral-500 italic">
              {row.r2Key ? "This payload could not be loaded from the archive." : "No payload was archived for this import."}
            </p>
          ) : (
            <pre className="max-h-[70vh] overflow-auto rounded-lg border border-neutral-800 bg-neutral-900/40 p-4 text-xs whitespace-pre-wrap text-neutral-200">
              {payload}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
