import { Card } from "@/components/ui/Card";

export type RoleHolder = { username: string | null; role: string; mainCharacterName: string };

// Leader request, 2026-09-05: "the dashboard page should also show a
// listing of the guild leaders and the officers (main chars only)". Main
// character only — an officer's alts aren't part of "the officer roster".
// Grouping is decided by the caller (dashboard/page.tsx): post-live-test-1
// LT-12 puts `leader` under Leaders and `officer` + `admin` under Officers
// — site-admin is a technical role, not a guild leadership seat, and it is
// not badged here at all (leader, 2026-09-11): members see officers, not
// who holds the site's admin bit.
export function GuildLeadership({ leadership, officers }: { leadership: RoleHolder[]; officers: RoleHolder[] }) {
  if (leadership.length === 0 && officers.length === 0) return null;

  return (
    <Card className="px-5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold">Leadership</h2>
        <p className="text-xs text-neutral-500">Main characters</p>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        <RoleGroup title="Leaders" holders={leadership} />
        <RoleGroup title="Officers" holders={officers} />
      </div>
    </Card>
  );
}

function RoleGroup({ title, holders }: { title: string; holders: RoleHolder[] }) {
  return (
    <div className="rounded-md border border-border/80 bg-neutral-900/25 px-3 py-2.5">
      <h3 className="text-sm font-semibold text-neutral-300">
        {title} <span className="font-normal text-neutral-500">({holders.length})</span>
      </h3>
      {holders.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500">None right now.</p>
      ) : (
        <ul className="mt-2 space-y-1 text-sm">
          {holders
            .slice()
            .sort((a, b) => a.mainCharacterName.localeCompare(b.mainCharacterName))
            .map((h) => (
              <li key={h.mainCharacterName} className="flex items-baseline justify-between gap-2">
                <span className="font-medium text-neutral-200">{h.mainCharacterName}</span>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
