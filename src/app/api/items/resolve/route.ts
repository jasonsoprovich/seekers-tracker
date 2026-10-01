import { getDb } from "@/lib/db";
import { MAX_RESOLVE_NAMES, resolveItemNames } from "@/lib/items/resolve";
import { getSession } from "@/lib/session";
import { itemTooltipsEnabled } from "@/lib/site-settings";

// Item name -> id, for the tooltip links. Session-gated and 401 JSON (never
// a redirect — it's fetched by client code). 404 while the admin toggle is
// off so a disabled feature does no work.
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "Not signed in." }, { status: 401 });
  if (!(await itemTooltipsEnabled())) return Response.json({ error: "Item tooltips are off." }, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const names = (body as { names?: unknown })?.names;
  if (!Array.isArray(names) || names.length > MAX_RESOLVE_NAMES || !names.every((n) => typeof n === "string" && n.length <= 200)) {
    return Response.json({ error: `Send up to ${MAX_RESOLVE_NAMES} item names.` }, { status: 400 });
  }
  const ids = await resolveItemNames(await getDb(), names as string[]);
  return Response.json({ ids }, { headers: { "Cache-Control": "private, max-age=3600" } });
}
