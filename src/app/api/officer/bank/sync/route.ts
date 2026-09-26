import { requireOfficerApiKey, requireOfficerCapability } from "@/lib/api-key-auth";
import { applySync, loadBankConfig, previewSync, validateSyncPayload, type OccupantInput, type SyncHolderInput, type SyncRowInput } from "@/lib/bank/sync";
import { getDb } from "@/lib/db";
import { officerApiActor, recordSystemEvent } from "@/lib/system-log";
import { LIMITS } from "@/lib/validate";

type RowBody = { container?: unknown; slotIndex?: unknown; category?: unknown; itemName?: unknown; itemId?: unknown; quantity?: unknown };
type OccupantBody = { container?: unknown; slotIndex?: unknown; itemId?: unknown; itemName?: unknown };
type HolderBody = { characterId?: unknown; sourceFile?: unknown; reportsSharedBank?: unknown; rows?: unknown; occupants?: unknown };
type SyncBody = { dryRun?: unknown; holders?: unknown };

function parseRow(raw: RowBody, index: number): { ok: true; value: SyncRowInput } | { ok: false; error: string } {
  if (typeof raw.container !== "string" || raw.container.length === 0) return { ok: false, error: `rows[${index}].container is required.` };
  if (typeof raw.slotIndex !== "number" || !Number.isInteger(raw.slotIndex) || raw.slotIndex < 0) {
    return { ok: false, error: `rows[${index}].slotIndex must be a non-negative integer.` };
  }
  if (raw.category !== "item" && raw.category !== "spell") return { ok: false, error: `rows[${index}].category must be "item" or "spell".` };
  if (typeof raw.itemName !== "string" || raw.itemName.trim().length === 0 || raw.itemName.length > LIMITS.itemName) {
    return { ok: false, error: `rows[${index}].itemName is required (max ${LIMITS.itemName} chars).` };
  }
  if (raw.itemId !== null && raw.itemId !== undefined && (typeof raw.itemId !== "number" || !Number.isInteger(raw.itemId))) {
    return { ok: false, error: `rows[${index}].itemId must be an integer or null.` };
  }
  if (typeof raw.quantity !== "number" || !Number.isInteger(raw.quantity) || raw.quantity <= 0 || raw.quantity > 1_000_000) {
    return { ok: false, error: `rows[${index}].quantity must be a positive integer.` };
  }
  return {
    ok: true,
    value: {
      container: raw.container,
      slotIndex: raw.slotIndex,
      category: raw.category,
      itemName: raw.itemName.trim(),
      itemId: raw.itemId ?? null,
      quantity: raw.quantity,
    },
  };
}

function parseOccupant(raw: OccupantBody, index: number): { ok: true; value: OccupantInput } | { ok: false; error: string } {
  if (typeof raw.container !== "string" || raw.container.length === 0) return { ok: false, error: `occupants[${index}].container is required.` };
  if (typeof raw.slotIndex !== "number" || !Number.isInteger(raw.slotIndex) || raw.slotIndex < 0) {
    return { ok: false, error: `occupants[${index}].slotIndex must be a non-negative integer.` };
  }
  if (raw.itemId !== null && raw.itemId !== undefined && (typeof raw.itemId !== "number" || !Number.isInteger(raw.itemId))) {
    return { ok: false, error: `occupants[${index}].itemId must be an integer or null.` };
  }
  if (typeof raw.itemName !== "string" || raw.itemName.length === 0 || raw.itemName.length > LIMITS.itemName) {
    return { ok: false, error: `occupants[${index}].itemName is required (max ${LIMITS.itemName} chars).` };
  }
  return { ok: true, value: { container: raw.container, slotIndex: raw.slotIndex, itemId: raw.itemId ?? null, itemName: raw.itemName } };
}

function parseHolder(raw: HolderBody, index: number): { ok: true; value: SyncHolderInput } | { ok: false; error: string } {
  if (typeof raw.characterId !== "number" || !Number.isInteger(raw.characterId)) {
    return { ok: false, error: `holders[${index}].characterId must be an integer.` };
  }
  if (raw.sourceFile !== undefined && raw.sourceFile !== null && typeof raw.sourceFile !== "string") {
    return { ok: false, error: `holders[${index}].sourceFile must be a string or null.` };
  }
  if (typeof raw.reportsSharedBank !== "boolean") {
    return { ok: false, error: `holders[${index}].reportsSharedBank must be a boolean.` };
  }
  if (!Array.isArray(raw.rows)) return { ok: false, error: `holders[${index}].rows must be an array.` };
  if (raw.rows.length > 300) return { ok: false, error: `holders[${index}].rows exceeds the maximum row count.` };
  const rawOccupants = raw.occupants ?? [];
  if (!Array.isArray(rawOccupants)) return { ok: false, error: `holders[${index}].occupants must be an array.` };
  if (rawOccupants.length > 300) return { ok: false, error: `holders[${index}].occupants exceeds the maximum count.` };

  const rows: SyncRowInput[] = [];
  for (let i = 0; i < raw.rows.length; i++) {
    const parsed = parseRow(raw.rows[i] as RowBody, i);
    if (!parsed.ok) return { ok: false, error: `holders[${index}].${parsed.error}` };
    rows.push(parsed.value);
  }

  const occupants: OccupantInput[] = [];
  for (let i = 0; i < rawOccupants.length; i++) {
    const parsed = parseOccupant(rawOccupants[i] as OccupantBody, i);
    if (!parsed.ok) return { ok: false, error: `holders[${index}].${parsed.error}` };
    occupants.push(parsed.value);
  }

  return {
    ok: true,
    value: {
      characterId: raw.characterId,
      sourceFile: raw.sourceFile ?? null,
      reportsSharedBank: raw.reportsSharedBank,
      rows,
      occupants,
    },
  };
}

// POST /api/officer/bank/sync — the actual guild bank sync (PLAN.md §11
// Phase 8.4). Body: { dryRun, holders: [{characterId, sourceFile,
// reportsSharedBank, rows}] }. The parser app has already filtered rows
// down to designated containers before building this payload, but every
// row is re-validated server-side against the live designations/account
// config (validateSyncPayload) — a stale client, a designation cleared
// mid-flight, or a hand-crafted request must never slip a personal item
// into the guild bank. dryRun (or an actual validation failure) never
// writes; the response's `diffs` is what the app's "Preview sync" modal
// renders either way.
export async function POST(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const db = await getDb();
  const capError = await requireOfficerCapability(db, auth.userId, "epgp.bank.manage");
  if (capError) return Response.json({ error: capError.error }, { status: capError.status });

  let body: SyncBody;
  try {
    body = (await request.json()) as SyncBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body.dryRun !== "boolean") return Response.json({ error: "`dryRun` must be a boolean." }, { status: 400 });
  if (!Array.isArray(body.holders) || body.holders.length === 0) {
    return Response.json({ error: "`holders` must be a non-empty array." }, { status: 400 });
  }
  if (body.holders.length > 50) return Response.json({ error: "Too many holders in one sync." }, { status: 400 });

  const holders: SyncHolderInput[] = [];
  for (let i = 0; i < body.holders.length; i++) {
    const parsed = parseHolder(body.holders[i] as HolderBody, i);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    holders.push(parsed.value);
  }

  const config = await loadBankConfig(db);
  const validationErrors = validateSyncPayload(holders, config);
  if (validationErrors.length > 0) {
    return Response.json({ error: "One or more rows are not designated as guild bank.", details: validationErrors }, { status: 422 });
  }

  const result = body.dryRun ? await previewSync(db, holders) : await applySync(db, auth.userId, holders, config);

  if (!body.dryRun) {
    const actor = await officerApiActor(db, auth.userId);
    const totalRows = holders.reduce((sum, h) => sum + h.rows.length, 0);
    await recordSystemEvent(db, actor, {
      action: "bank.import",
      targetType: "bank_holdings",
      summary: `Guild bank synced: ${holders.length} holder(s), ${totalRows} row(s)`,
      after: { holderCharacterIds: holders.map((h) => h.characterId), totalRows },
    });
  }

  return Response.json({ ok: true, applied: !body.dryRun, diffs: result.diffs });
}
