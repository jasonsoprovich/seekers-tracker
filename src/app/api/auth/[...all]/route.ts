import { getCloudflareContext } from "@opennextjs/cloudflare";

import { createAuth } from "@/auth";

async function handler(req: Request) {
  const { env, cf } = await getCloudflareContext({ async: true });
  const auth = createAuth(env, cf, new URL(req.url).origin);
  return auth.handler(req);
}

export const GET = handler;
export const POST = handler;
