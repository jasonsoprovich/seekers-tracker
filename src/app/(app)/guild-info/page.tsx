import { redirect } from "next/navigation";

import { GuildInfoCards } from "@/components/guild-info/GuildInfoCards";
import { PageHeader } from "@/components/shell/PageHeader";
import { getDb } from "@/lib/db";
import { listGuildInfoCards } from "@/lib/guild-info";
import { getPermissions } from "@/lib/permissions";
import { getSession } from "@/lib/session";

// Leader-maintained guild rules/info (leader request, 2026-09-30). Every
// member can read it; only "guild.info.edit" (leaders + admins by default)
// sees the editing controls — and every action re-checks that itself.
export default async function GuildInformationPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const perms = await getPermissions(session.user.id);
  const cards = await listGuildInfoCards(db);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Guild Information" subtitle="Guild rules, policies, and info — kept up to date by the guild leaders." />
      <GuildInfoCards
        canEdit={perms.can("guild.info.edit")}
        cards={cards.map((c) => ({ id: c.id, title: c.title, body: c.body, width: c.width }))}
      />
    </div>
  );
}
