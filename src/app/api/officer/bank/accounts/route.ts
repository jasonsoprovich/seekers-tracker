import { requireOfficerApiKey, requireOfficerCapability } from "@/lib/api-key-auth";
import { deleteEqAccount, saveEqAccount } from "@/lib/bank/sync";
import { getDb } from "@/lib/db";
import { officerApiActor, recordSystemEvent } from "@/lib/system-log";
import { LIMITS } from "@/lib/validate";

type SaveBody = { id?: unknown; label?: unknown; characterIds?: unknown; sharedBankHolderCharacterId?: unknown };

// PUT /api/officer/bank/accounts — create or update one "these characters
// share a real EQ login" group (PLAN.md §9 addendum). The officer app
// auto-suggests a group from matching SharedBank fingerprints; this is
// where the officer's confirmation (or manual grouping) actually lands.
export async function PUT(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const db = await getDb();
  const capError = await requireOfficerCapability(db, auth.userId, "epgp.bank.manage");
  if (capError) return Response.json({ error: capError.error }, { status: capError.status });

  let body: SaveBody;
  try {
    body = (await request.json()) as SaveBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body.label !== "string" || body.label.trim().length === 0 || body.label.length > LIMITS.characterName * 4) {
    return Response.json({ error: "`label` is required." }, { status: 400 });
  }
  if (!Array.isArray(body.characterIds) || !body.characterIds.every((id) => typeof id === "number" && Number.isInteger(id))) {
    return Response.json({ error: "`characterIds` must be an array of integers." }, { status: 400 });
  }
  if (typeof body.sharedBankHolderCharacterId !== "number" || !Number.isInteger(body.sharedBankHolderCharacterId)) {
    return Response.json({ error: "`sharedBankHolderCharacterId` must be an integer." }, { status: 400 });
  }
  if (body.id !== undefined && (typeof body.id !== "number" || !Number.isInteger(body.id))) {
    return Response.json({ error: "`id` must be an integer when provided." }, { status: 400 });
  }

  const result = await saveEqAccount(db, auth.userId, {
    id: body.id as number | undefined,
    label: body.label,
    characterIds: body.characterIds as number[],
    sharedBankHolderCharacterId: body.sharedBankHolderCharacterId,
  });
  if (result.error) return Response.json({ error: result.error }, { status: 422 });

  const actor = await officerApiActor(db, auth.userId);
  await recordSystemEvent(db, actor, {
    action: "bank.account.update",
    targetType: "bank_eq_account",
    targetId: result.id ?? null,
    targetLabel: body.label,
    summary: `Guild bank EQ account group saved: "${body.label}" (${(body.characterIds as number[]).length} character(s))`,
  });

  return Response.json({ ok: true, id: result.id });
}

type DeleteBody = { id?: unknown };

export async function DELETE(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const db = await getDb();
  const capError = await requireOfficerCapability(db, auth.userId, "epgp.bank.manage");
  if (capError) return Response.json({ error: capError.error }, { status: capError.status });

  let body: DeleteBody;
  try {
    body = (await request.json()) as DeleteBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (typeof body.id !== "number" || !Number.isInteger(body.id)) {
    return Response.json({ error: "`id` must be an integer." }, { status: 400 });
  }

  const result = await deleteEqAccount(db, body.id);
  if (result.error) return Response.json({ error: result.error }, { status: 404 });

  const actor = await officerApiActor(db, auth.userId);
  await recordSystemEvent(db, actor, {
    action: "bank.account.delete",
    targetType: "bank_eq_account",
    targetId: body.id,
    summary: `Guild bank EQ account group ${body.id} deleted`,
  });

  return Response.json({ ok: true });
}
