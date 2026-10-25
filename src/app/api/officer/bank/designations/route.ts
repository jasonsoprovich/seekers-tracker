import { requireOfficerApiKey, requireOfficerCapability } from "@/lib/api-key-auth";
import { updateDesignations, type DesignationInput } from "@/lib/bank/sync";
import { getDb } from "@/lib/db";
import { officerApiActor, recordSystemEvent } from "@/lib/system-log";

type SlotBody = { container?: unknown; slotIndex?: unknown; expectedItemId?: unknown; expectedItemName?: unknown };
type RemoveSlotBody = { container?: unknown; slotIndex?: unknown };
type DesignationsBody = {
  characterId?: unknown;
  eqAccountId?: unknown;
  set?: unknown;
  add?: unknown;
  remove?: unknown;
};

function parseSlots(raw: unknown): DesignationInput[] | null {
  if (!Array.isArray(raw)) return null;
  const out: DesignationInput[] = [];
  for (const item of raw as SlotBody[]) {
    if (typeof item.container !== "string" || item.container.length === 0) return null;
    if (typeof item.slotIndex !== "number" || !Number.isInteger(item.slotIndex) || item.slotIndex < 0) return null;
    const expectedItemId = item.expectedItemId === null || item.expectedItemId === undefined ? null : item.expectedItemId;
    if (expectedItemId !== null && (typeof expectedItemId !== "number" || !Number.isInteger(expectedItemId))) return null;
    const expectedItemName = item.expectedItemName === null || item.expectedItemName === undefined ? null : item.expectedItemName;
    if (expectedItemName !== null && typeof expectedItemName !== "string") return null;
    out.push({ container: item.container, slotIndex: item.slotIndex, expectedItemId, expectedItemName });
  }
  return out;
}

function parseRemoveSlots(raw: unknown): { container: string; slotIndex: number }[] | null {
  if (!Array.isArray(raw)) return null;
  const out: { container: string; slotIndex: number }[] = [];
  for (const item of raw as RemoveSlotBody[]) {
    if (typeof item.container !== "string" || item.container.length === 0) return null;
    if (typeof item.slotIndex !== "number" || !Number.isInteger(item.slotIndex) || item.slotIndex < 0) return null;
    out.push({ container: item.container, slotIndex: item.slotIndex });
  }
  return out;
}

// PUT /api/officer/bank/designations — mutates one character's guild-flagged
// positions (its Bank/General slots and, since 2026-10-25, its SharedBank
// slots — EQ account groups are gone). Since the 2026-09-25 officer-feedback pass, a
// "position" is (container, slotIndex): slotIndex 0 flags the whole
// top-level container, 1..N flags one item inside a bag. Body takes any
// combination of:
//   - `set`: replace the owner's ENTIRE list (used by "Mark all Bank slots
//     guild" / "Clear all personal designations" — a wholesale replace).
//   - `add` / `remove`: touch only the listed positions, leaving every
//     other flag untouched — used by an individual checkbox toggle. This
//     is what fixes the pre-2026-09-25 bug where toggling one container
//     PUT the whole set rebuilt from the current export, silently
//     dropping a flag on a container that happened to be missing from
//     that scan (e.g. a moved bag's old, now-empty slot).
export async function PUT(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const db = await getDb();
  const capError = await requireOfficerCapability(db, auth.userId, "epgp.bank.manage");
  if (capError) return Response.json({ error: capError.error }, { status: capError.status });

  let body: DesignationsBody;
  try {
    body = (await request.json()) as DesignationsBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // An officer app from before 2026-10-25 flags SharedBank slots on an EQ
  // account group; those no longer exist.
  if (body.eqAccountId !== undefined && body.eqAccountId !== null && body.eqAccountId !== 0) {
    return Response.json(
      { error: "EQ account groups were removed. Update the officer app to flag Shared Bank slots per character." },
      { status: 410 },
    );
  }
  if (typeof body.characterId !== "number" || !Number.isInteger(body.characterId) || body.characterId <= 0) {
    return Response.json({ error: "`characterId` is required." }, { status: 400 });
  }
  const characterId = body.characterId;
  if (body.set === undefined && body.add === undefined && body.remove === undefined) {
    return Response.json({ error: "At least one of `set`/`add`/`remove` is required." }, { status: 400 });
  }

  let set: DesignationInput[] | undefined;
  if (body.set !== undefined) {
    const parsed = parseSlots(body.set);
    if (!parsed) return Response.json({ error: "`set` must be an array of valid positions." }, { status: 400 });
    set = parsed;
  }
  let add: DesignationInput[] | undefined;
  if (body.add !== undefined) {
    const parsed = parseSlots(body.add);
    if (!parsed) return Response.json({ error: "`add` must be an array of valid positions." }, { status: 400 });
    add = parsed;
  }
  let remove: { container: string; slotIndex: number }[] | undefined;
  if (body.remove !== undefined) {
    const parsed = parseRemoveSlots(body.remove);
    if (!parsed) return Response.json({ error: "`remove` must be an array of valid positions." }, { status: 400 });
    remove = parsed;
  }

  const result = await updateDesignations(db, auth.userId, characterId, { set, add, remove });
  if (result.error) return Response.json({ error: result.error }, { status: 422 });

  const actor = await officerApiActor(db, auth.userId);
  const summaryParts: string[] = [];
  if (set) summaryParts.push(`set ${set.length}`);
  if (add) summaryParts.push(`+${add.length}`);
  if (remove) summaryParts.push(`-${remove.length}`);
  await recordSystemEvent(db, actor, {
    action: "bank.designations.update",
    targetType: "character",
    targetId: characterId,
    summary: `Guild bank designations updated: ${summaryParts.join(", ")}`,
  });

  return Response.json({ ok: true });
}
