import { getCloudflareContext } from "@opennextjs/cloudflare";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { createAuth } from "@/auth";
import { GenerateAppKeyForm } from "@/components/epgp/GenerateAppKeyForm";
import { RevokeAppKeyButton } from "@/components/epgp/RevokeAppKeyButton";
import { PageHeader } from "@/components/shell/PageHeader";
import { canManageEpgp, getUserRole } from "@/lib/authz";
import { getSession } from "@/lib/session";

export default async function AppKeyPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);
  if (!canManageEpgp(role)) redirect("/roster");

  const { env, cf } = await getCloudflareContext({ async: true });
  const auth = createAuth(env, cf);
  const { apiKeys } = await auth.api.listApiKeys({ headers: await headers() });

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="EPGP Parser App Key"
        subtitle="Generate a key to connect the standalone EPGP parser app to your account — it can submit attendance, bids, and manual entries on your behalf."
      />

      <div className="mt-6">
        <GenerateAppKeyForm />
      </div>

      <div className="mt-8 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Created</th>
              <th className="px-3 py-2 font-medium">Expires</th>
              <th className="px-3 py-2 font-medium">Last used</th>
              <th className="px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {apiKeys.map((k) => (
              <tr key={k.id} className="hover:bg-neutral-900/40">
                <td className="px-3 py-2 font-medium">{k.name ?? "—"}</td>
                <td className="px-3 py-2 text-neutral-400">{new Date(k.createdAt).toLocaleDateString()}</td>
                <td className="px-3 py-2 text-neutral-400">{k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : "Never"}</td>
                <td className="px-3 py-2 text-neutral-400">{k.lastRequest ? new Date(k.lastRequest).toLocaleDateString() : "Never"}</td>
                <td className="px-3 py-2">
                  <RevokeAppKeyButton keyId={k.id} name={k.name ?? "this key"} />
                </td>
              </tr>
            ))}
            {apiKeys.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-neutral-500">
                  No app keys yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
