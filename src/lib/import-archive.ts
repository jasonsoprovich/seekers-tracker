import { getCloudflareContext } from "@opennextjs/cloudflare";

// Raw import payload archive (§6/§9 task 17): stores exactly what a member
// submitted — Seer text, a pq-companion export, or a Quarmy gear export —
// keyed from `import_log.r2_key` so an officer can audit exactly what was
// imported later, independent of how the parser interpreted it at the time.
//
// R2 was called "optional" in the stack decision (§2) — a write failure here
// shouldn't block the import itself (the D1 rows are the state that
// matters), so callers get `null` back on failure rather than a thrown
// error, and just omit r2Key from the import_log row.
export type ImportArchiveKind = "seer_text" | "pqc_export" | "gear_export";

export async function archiveImportPayload(
  kind: ImportArchiveKind,
  characterId: number,
  raw: string,
): Promise<string | null> {
  try {
    const { env } = await getCloudflareContext({ async: true });
    const key = `${characterId}/${kind}/${Date.now()}-${crypto.randomUUID()}.txt`;
    await env.IMPORT_ARCHIVE.put(key, raw, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
    return key;
  } catch {
    return null;
  }
}

export async function readImportPayload(key: string): Promise<string | null> {
  const { env } = await getCloudflareContext({ async: true });
  const obj = await env.IMPORT_ARCHIVE.get(key);
  if (!obj) return null;
  return obj.text();
}
