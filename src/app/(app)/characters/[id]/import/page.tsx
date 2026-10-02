import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";

import { PageHeader } from "@/components/shell/PageHeader";
import { characters } from "@/db";
import { canManageCharacter } from "@/lib/permissions";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";
import { ImportPqExportForm } from "@/components/ImportPqExportForm";
import { ImportPopFlagsForm } from "@/components/ImportPopFlagsForm";
import { ImportSeerForm } from "@/components/ImportSeerForm";
import { ImportTabs } from "@/components/import/ImportTabs";

import { importPopFlagsText, importPqCompanionExport, importSeerText } from "./actions";

export default async function ImportSeerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const characterId = Number(id);
  if (!Number.isInteger(characterId)) notFound();

  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const [character] = await db.select().from(characters).where(eq(characters.id, characterId));
  if (!character) notFound();
  if (!(await canManageCharacter(character, session.user.id))) redirect("/characters");

  const boundImportSeer = importSeerText.bind(null, characterId);
  const boundImportPopFlags = importPopFlagsText.bind(null, characterId);
  const boundImportPqExport = importPqCompanionExport.bind(null, characterId);

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        breadcrumbs={[
          { label: "Characters", href: "/characters" },
          { label: character.name, href: `/characters/${character.id}` },
          { label: "Import" },
        ]}
        title={`Import Progress — ${character.name}`}
      />

      <ImportTabs
        pqc={
          <div className="flex flex-col gap-4">
            <p className="max-w-xl text-sm text-neutral-400">
              Preferred once pq-companion ships an &quot;Export Guild Progress&quot; button on its PoP Flagging
              page: paste the exported JSON below. It carries pq-companion&apos;s already-resolved flag state —
              including manual corrections made there — so no re-parsing happens on this end, just validation and
              upsert.
            </p>
            <ImportPqExportForm action={boundImportPqExport} />
          </div>
        }
        popflags={
          <div className="flex flex-col gap-4">
            <p className="max-w-xl text-sm text-neutral-400">
              In game, type <code className="text-neutral-200">#popflags</code> and then{" "}
              <code className="text-neutral-200">#popflags 1</code> through{" "}
              <code className="text-neutral-200">#popflags 4</code> (and <code className="text-neutral-200">#popflags 5</code>{" "}
              for Plane of Time). Then copy those lines out of your EverQuest log file and paste them below — one
              report or all of them at once, timestamps and unrelated chat lines are fine. The same output
              pq-companion reads. Only flags the report proves are done get added; your existing tracking is never
              removed.
            </p>
            <ImportPopFlagsForm action={boundImportPopFlags} />
          </div>
        }
        seer={
          <div className="flex flex-col gap-4">
            <p className="max-w-xl text-sm text-neutral-400">
              Sit and say &quot;guided meditation&quot; to the Seer Mal Nae`Shi, then paste the full reply below.
              This detects PoP flags from the qglobals it reports — it won&apos;t catch flags with no in-game
              signal (keys, kills), those are set from the checklist instead.
            </p>
            <ImportSeerForm action={boundImportSeer} />
          </div>
        }
      />
    </div>
  );
}
