// Validation for pq-companion's PoP Flagging export JSON (the file its
// "Export" button downloads as pq-companion-popflags-YYYY-MM-DD.json; built
// by backend/internal/api/popflag_summary.go there).
//
// Unlike seer.ts there's no completion logic here: pq-companion has already
// resolved any-of groups, bitmasks, and manual-override precedence, so this
// site only validates the shape and upserts the done/not-done state.
//
// Document:
//   {
//     "kind": "pq-companion.popflags",
//     "version": 1,
//     "exported_at": "2026-10-09T00:12:40Z",
//     "characters": [
//       { "name": "Osui", "done": 10, "total": 48, "zones": {...},
//         "flags": [ { "id": "poj_preflag", "tier": 1, "zone": "...",
//                      "label": "...", "done": true, "source": "manual" } ] }
//     ]
//   }
// The export covers every character on the exporting PC; only name and each
// flag's id/done are used here.

export const PQC_EXPORT_KIND = "pq-companion.popflags";
export const PQC_EXPORT_VERSION = 1;

export interface PqExportFlag {
  flagId: string;
  done: boolean;
}

export interface PqExportCharacter {
  name: string;
  flags: PqExportFlag[];
}

export interface PqExportPayload {
  exportedAt: string | null;
  characters: PqExportCharacter[];
}

export function parsePqExport(raw: string): { data: PqExportPayload } | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { error: "That's not valid JSON. Use the .json file from pq-companion's PoP Flagging export." };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { error: "Expected a JSON object." };
  }
  const obj = json as Record<string, unknown>;

  if (obj.kind !== PQC_EXPORT_KIND) {
    return {
      error: `This isn't a pq-companion PoP flags export (expected kind "${PQC_EXPORT_KIND}"). If you have #popflags log text, use the #popflags tab instead.`,
    };
  }
  if (obj.version !== PQC_EXPORT_VERSION) {
    return {
      error: `Unsupported export version (expected ${PQC_EXPORT_VERSION}, got ${JSON.stringify(obj.version)}). The site may need an update for this pq-companion version.`,
    };
  }
  if (!Array.isArray(obj.characters)) {
    return { error: 'Missing or invalid "characters" array.' };
  }

  const characters: PqExportCharacter[] = [];
  for (const entry of obj.characters) {
    if (typeof entry !== "object" || entry === null) continue;
    const c = entry as Record<string, unknown>;
    if (typeof c.name !== "string" || !c.name.trim() || !Array.isArray(c.flags)) continue;
    const flags: PqExportFlag[] = [];
    for (const f of c.flags) {
      if (typeof f !== "object" || f === null) continue;
      const e = f as Record<string, unknown>;
      if (typeof e.id !== "string" || typeof e.done !== "boolean") continue;
      flags.push({ flagId: e.id, done: e.done });
    }
    if (flags.length > 0) characters.push({ name: c.name.trim(), flags });
  }
  if (characters.length === 0) {
    return { error: "No characters with usable flags in that file." };
  }

  return {
    data: { exportedAt: typeof obj.exported_at === "string" ? obj.exported_at : null, characters },
  };
}
