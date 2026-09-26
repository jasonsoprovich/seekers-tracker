import { requireOfficerApiKey, requireOfficerCapability } from "@/lib/api-key-auth";
import { loadBankConfig } from "@/lib/bank/sync";
import { getDb } from "@/lib/db";

// GET /api/officer/bank/sync's counterpart read: every designation, every
// EQ-account group, and each holder's last import — everything the parser
// app's Guild Bank tab needs to render its character list and build a
// sync payload the server will actually accept. See src/lib/bank/sync.ts.
export async function GET(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const db = await getDb();
  const capError = await requireOfficerCapability(db, auth.userId, "epgp.bank.manage");
  if (capError) return Response.json({ error: capError.error }, { status: capError.status });

  const config = await loadBankConfig(db);

  return Response.json({
    personalDesignations: Object.fromEntries(config.personalDesignations),
    sharedDesignations: Object.fromEntries(config.sharedDesignations),
    accounts: config.accounts,
    lastImports: Object.fromEntries([...config.lastImports].map(([id, info]) => [id, { ...info, createdAt: info.createdAt.toISOString() }])),
    syncedContents: Object.fromEntries(config.syncedContents),
  });
}
