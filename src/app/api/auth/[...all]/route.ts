import { getCloudflareContext } from "@opennextjs/cloudflare";

import { createAuth } from "@/auth";

async function handler(req: Request) {
  const { env, cf } = await getCloudflareContext({ async: true });
  // Wrangler's local dev simulates the configured `routes` custom-domain
  // hostname (wrangler.jsonc) for the Request object the Worker sees,
  // regardless of the actual localhost:PORT the browser connected to — so
  // `new URL(req.url).origin` resolves to the production hostname even in
  // local dev. Prefer the explicit BETTER_AUTH_URL env var (set in
  // .dev.vars for local dev) when present, since it reflects where the app
  // is actually reachable; fall back to the request origin otherwise.
  const baseURL = env.BETTER_AUTH_URL || new URL(req.url).origin;
  const auth = createAuth(env, cf, baseURL);
  return auth.handler(req);
}

export const GET = handler;
export const POST = handler;
