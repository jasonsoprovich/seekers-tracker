import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";

import { characters } from "@/db";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";
import { ImportGearForm } from "@/components/ImportGearForm";
import { ImportPqExportForm } from "@/components/ImportPqExportForm";
import { ImportSeerForm } from "@/components/ImportSeerForm";

import { importGear, importPqCompanionExport, importSeerText } from "./actions";

export default async function ImportSeerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const characterId = Number(id);
  if (!Number.isInteger(characterId)) notFound();

  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const [character] = await db.select().from(characters).where(eq(characters.id, characterId));
  if (!character) notFound();
  if (character.ownerId !== session.user.id) redirect("/characters");

  const boundImportSeer = importSeerText.bind(null, characterId);
  const boundImportPqExport = importPqCompanionExport.bind(null, characterId);
  const boundImportGear = importGear.bind(null, characterId);

  return (
    <div className="min-h-screen bg-neutral-950 px-6 py-10 text-neutral-100">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-bold">Import Progress — {character.name}</h1>

        <section className="mt-8">
          <h2 className="text-lg font-semibold">pq-companion Export</h2>
          <p className="mt-2 max-w-xl text-sm text-neutral-400">
            Preferred once pq-companion ships an &quot;Export Guild Progress&quot; button on its PoP Flagging
            page: paste the exported JSON below. It carries pq-companion&apos;s already-resolved flag state —
            including manual corrections made there — so no re-parsing happens on this end, just validation
            and upsert.
          </p>
          <div className="mt-4">
            <ImportPqExportForm action={boundImportPqExport} />
          </div>
        </section>

        <section className="mt-10 border-t border-neutral-800 pt-8">
          <h2 className="text-lg font-semibold">Seer Text</h2>
          <p className="mt-2 max-w-xl text-sm text-neutral-400">
            Sit and say &quot;guided meditation&quot; to the Seer Mal Nae`Shi, then paste the full reply below.
            This detects PoP flags from the qglobals it reports — it won&apos;t catch flags with no in-game
            signal (keys, kills), those are set from the checklist instead.
          </p>
          <div className="mt-4">
            <ImportSeerForm action={boundImportSeer} />
          </div>
        </section>

        <section className="mt-10 border-t border-neutral-800 pt-8">
          <h2 className="text-lg font-semibold">Gear Export</h2>
          <p className="mt-2 max-w-xl text-sm text-neutral-400">
            Zeal writes a <code>&lt;CharName&gt;-Quarmy.txt</code> file to your EverQuest folder on logout. Paste
            its full contents below to populate the gear list — this replaces whatever was imported last time, so
            it always reflects your current loadout.
          </p>
          <div className="mt-4">
            <ImportGearForm action={boundImportGear} />
          </div>
        </section>
      </div>
    </div>
  );
}
