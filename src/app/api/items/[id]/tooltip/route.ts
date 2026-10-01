import { eq } from "drizzle-orm";

import { itemTooltips } from "@/db";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";
import { itemTooltipsEnabled } from "@/lib/site-settings";

const PQDI = "https://www.pqdi.cc";
const TTL_SECONDS = 30 * 24 * 3600;
// Item stats never change, so the browser may keep its copy for the same span.
const BROWSER_CACHE = `private, max-age=${TTL_SECONDS}, immutable`;

function htmlResponse(html: string, source: "edge" | "d1" | "pqdi") {
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": BROWSER_CACHE, "x-tooltip-source": source },
  });
}

// Server-side proxy for PQDI's item tooltip fragment
// (GET /get-item-tooltip/{id}, an HTML snippet with relative icon/spell
// URLs). Proxied rather than called from the browser so we can cache it:
// edge cache (per data center) -> D1 (permanent, global) -> PQDI, so each item
// is fetched from PQDI once ever. PQDI is one hobbyist's PythonAnywhere host,
// and every guild member hovering the same drop shouldn't each hit it. The
// client sanitizes the fragment before inserting it; this route only relays it.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "Not signed in." }, { status: 401 });
  if (!(await itemTooltipsEnabled())) return Response.json({ error: "Item tooltips are off." }, { status: 404 });

  const { id } = await params;
  if (!/^\d{1,7}$/.test(id)) return Response.json({ error: "Invalid item id." }, { status: 400 });

  // Cache API keys must be URLs; this one is internal and never fetched.
  const cacheKey = new Request(`https://item-tooltip.cache.invalid/${id}`);
  const edge = typeof caches !== "undefined" ? (caches as unknown as { default?: Cache }).default : undefined;
  const hit = await edge?.match(cacheKey).catch(() => undefined);
  if (hit) return htmlResponse(await hit.text(), "edge");

  const putEdge = async (html: string) => {
    // Edge copy is shared across users, so store it with a public header.
    const shared = new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": `public, max-age=${TTL_SECONDS}` } });
    await edge?.put(cacheKey, shared).catch(() => {});
  };

  const itemId = Number(id);
  let db: Awaited<ReturnType<typeof getDb>> | undefined;
  try {
    db = await getDb();
    const [row] = await db.select({ html: itemTooltips.html }).from(itemTooltips).where(eq(itemTooltips.itemId, itemId));
    if (row) {
      await putEdge(row.html);
      return htmlResponse(row.html, "d1");
    }
  } catch {
    // the store is an optimization — fall through to PQDI
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${PQDI}/get-item-tooltip/${id}`, { signal: AbortSignal.timeout(5000), headers: { Accept: "text/html" } });
  } catch {
    return Response.json({ error: "PQDI is unavailable." }, { status: 502 });
  }
  if (!upstream.ok) return Response.json({ error: "PQDI has no tooltip for that item." }, { status: upstream.status === 404 ? 404 : 502 });

  const html = await upstream.text();
  await putEdge(html);
  if (db) await db.insert(itemTooltips).values({ itemId, html }).onConflictDoNothing().catch(() => {});
  return htmlResponse(html, "pqdi");
}
