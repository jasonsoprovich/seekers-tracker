// Shape validation for pq-companion's "Export Guild Progress" JSON — see
// docs/guild-website-feasibility.md §6/§9 task 14. Not yet built on
// pq-companion's side (filed as a follow-up feature request there); this
// module defines the schema this site expects so pq-companion's eventual
// export matches it exactly.
//
// Unlike seer.ts, there's no completion logic here: pq-companion has
// already resolved any-of groups, bitmasks, and manual-override precedence
// on its end, and the export "carries a member's manual corrections, not
// just a fresh Seer reading" — this site only validates the shape and
// upserts the done/not-done state it's given.
//
// Expected document:
//   {
//     "schema_version": 1,
//     "character": { "name": "Osui", "class": 13, "race": 6, "level": 60 },
//     "pop_flags": [
//       { "flag_id": "poj_preflag", "done": true, "source": "seer", "updated_at": 1755302400 }
//     ],
//     "exported_at": "2026-08-16T12:00:00Z"
//   }
// Only schema_version, character.name, and each flag's flag_id/done are
// used — class/race/level and the export's own source/updated_at/
// exported_at aren't consumed (this site stamps its own source="import"
// and updated_at on the rows it writes).

export interface PqExportFlag {
  flagId: string;
  done: boolean;
}

export interface PqExportPayload {
  characterName: string;
  flags: PqExportFlag[];
}

export function parsePqExport(raw: string): { data: PqExportPayload } | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { error: "That's not valid JSON." };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { error: "Expected a JSON object." };
  }
  const obj = json as Record<string, unknown>;

  if (obj.schema_version !== 1) {
    return { error: `Unsupported schema_version (expected 1, got ${JSON.stringify(obj.schema_version)}).` };
  }

  const character = obj.character;
  if (typeof character !== "object" || character === null || Array.isArray(character)) {
    return { error: 'Missing or invalid "character" field.' };
  }
  const characterName = (character as Record<string, unknown>).name;
  if (typeof characterName !== "string" || !characterName.trim()) {
    return { error: "Missing character.name." };
  }

  const popFlags = obj.pop_flags;
  if (!Array.isArray(popFlags)) {
    return { error: 'Missing or invalid "pop_flags" array.' };
  }

  const flags: PqExportFlag[] = [];
  for (const entry of popFlags) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.flag_id !== "string" || typeof e.done !== "boolean") continue;
    flags.push({ flagId: e.flag_id, done: e.done });
  }
  if (flags.length === 0) {
    return { error: 'No usable entries in "pop_flags" — each needs a string flag_id and boolean done.' };
  }

  return { data: { characterName, flags } };
}
