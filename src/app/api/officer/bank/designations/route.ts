import { requireOfficerApiKey, requireOfficerCapability } from "@/lib/api-key-auth";
import { setDesignations, type DesignationOwner } from "@/lib/bank/sync";
import { getDb } from "@/lib/db";
import { officerApiActor, recordSystemEvent } from "@/lib/system-log";

type DesignationsBody = { characterId?: unknown; eqAccountId?: unknown; containers?: unknown };

// PUT /api/officer/bank/designations — replaces the FULL set of guild-flagged
// containers for one owner (a character's personal Bank/General slots, or
// an EQ account's SharedBank slots). Not a toggle-one-container endpoint:
// the officer app always sends the complete current set after a checkbox
// change, same "replace the whole list" shape as PUT bank/accounts.
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

  const hasCharacterId = typeof body.characterId === "number" && Number.isInteger(body.characterId);
  const hasEqAccountId = typeof body.eqAccountId === "number" && Number.isInteger(body.eqAccountId);
  if (hasCharacterId === hasEqAccountId) {
    return Response.json({ error: "Exactly one of `characterId`/`eqAccountId` is required." }, { status: 400 });
  }
  if (!Array.isArray(body.containers) || !body.containers.every((c) => typeof c === "string")) {
    return Response.json({ error: "`containers` must be an array of strings." }, { status: 400 });
  }

  const owner: DesignationOwner = hasCharacterId ? { characterId: body.characterId as number } : { eqAccountId: body.eqAccountId as number };
  const result = await setDesignations(db, auth.userId, owner, body.containers as string[]);
  if (result.error) return Response.json({ error: result.error }, { status: 422 });

  const actor = await officerApiActor(db, auth.userId);
  await recordSystemEvent(db, actor, {
    action: "bank.designations.update",
    targetType: hasCharacterId ? "character" : "bank_eq_account",
    targetId: hasCharacterId ? (body.characterId as number) : (body.eqAccountId as number),
    summary: `Guild bank designations updated: ${(body.containers as string[]).length} container(s)`,
  });

  return Response.json({ ok: true });
}
