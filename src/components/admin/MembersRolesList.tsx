"use client";

import { useMemo, useState } from "react";

import { RemoveMemberButton } from "@/components/admin/RemoveMemberButton";
import { RoleSelect } from "@/components/RoleSelect";
import { fieldClasses } from "@/components/ui/Field";
import type { Role } from "@/lib/authz";

export type MemberRow = {
  id: string;
  username: string | null;
  role: Role;
  discordVerified: boolean;
  createdAt: Date;
  playerStatus: string | null;
};

// Guild-wide member list can run into the hundreds — same problem the "All
// Characters" list already solved below it, and the same fix a guild
// leader had used before this section was reordered above that list
// (leader, 2026-09-05: "doesnt seem to be a search by name thing like
// there was"). Client-side filter, no pagination needed at this scale.
export function MembersRolesList({ members, selfUserId }: { members: MemberRow[]; selfUserId: string }) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) => (m.username ?? "").toLowerCase().includes(q));
  }, [members, search]);

  return (
    <div>
      <label className="mt-4 flex max-w-xs flex-col gap-1 text-sm">
        <span className="text-neutral-400">Search</span>
        <input
          type="text"
          placeholder="Username…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={fieldClasses({ size: "sm" })}
        />
      </label>

      {filtered.length === 0 ? (
        <p className="mt-4 text-neutral-400">No members match &quot;{search}&quot;.</p>
      ) : (
        <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
          {filtered.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="font-medium">{m.username ?? "(no username)"}</p>
                <p className="text-sm text-neutral-500">
                  {m.discordVerified ? "Discord verified" : "Not Discord-verified"} · joined{" "}
                  {m.createdAt.toLocaleDateString()}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <RemoveMemberButton
                  userId={m.id}
                  username={m.username ?? "this member"}
                  departed={m.playerStatus === "departed"}
                  isSelf={m.id === selfUserId}
                />
                <RoleSelect userId={m.id} role={m.role} isSelf={m.id === selfUserId} />
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2 text-xs text-neutral-500">
        {filtered.length} of {members.length} member{members.length === 1 ? "" : "s"}
      </p>
    </div>
  );
}
