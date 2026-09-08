"use client";

import { useRouter } from "next/navigation";
import { useId, useMemo, useState } from "react";

import { assignCharacterToMember } from "@/app/(app)/admin/actions";
import { RemoveMemberButton } from "@/components/admin/RemoveMemberButton";
import { RoleSelect } from "@/components/RoleSelect";
import { fieldClasses } from "@/components/ui/Field";
import type { Role } from "@/lib/authz";
import { guildDate } from "@/lib/guild-timezone";

export type MemberRow = {
  id: string;
  username: string | null;
  role: Role;
  discordVerified: boolean;
  createdAt: Date;
  playerStatus: string | null;
};

export type UnclaimedCharacter = { id: number; name: string; charType: "main" | "alt" | "mule" };

// One unclaimed-character picker per member row. Officers, leaders and
// admins can attach a roster character to an account here without the
// member having to file a claim first — for the common case where an
// officer already knows whose character it is. Assigning a main and then
// its alts is just repeated use (each assignment removes that character
// from the list on refresh).
function AssignCharacterControl({ userId, characters }: { userId: string; characters: UnclaimedCharacter[] }) {
  const router = useRouter();
  const listId = useId();
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const byName = useMemo(() => new Map(characters.map((c) => [c.name.toLowerCase(), c])), [characters]);

  async function assign() {
    const match = byName.get(value.trim().toLowerCase());
    if (!match) {
      setError("Pick an unclaimed character from the list.");
      return;
    }
    setPending(true);
    setError(null);
    const res = await assignCharacterToMember(userId, match.id);
    setPending(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setValue("");
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <input
          type="text"
          list={listId}
          placeholder="Assign a character…"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          className={`${fieldClasses({ size: "sm" })} w-44`}
        />
        <datalist id={listId}>
          {characters.map((c) => (
            <option key={c.id} value={c.name}>
              {c.charType === "main" ? "" : `(${c.charType})`}
            </option>
          ))}
        </datalist>
        <button
          type="button"
          onClick={assign}
          disabled={pending || value.trim() === ""}
          className="rounded-md border border-field px-2.5 py-1 text-sm font-medium text-neutral-300 hover:border-emerald-500/60 hover:text-emerald-300 disabled:opacity-40"
        >
          {pending ? "Assigning…" : "Assign"}
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

// Guild-wide member list can run into the hundreds — same problem the "All
// Characters" list already solved, so a client-side username filter.
// `canEditRoles` gates the leader/admin-only role picker and remove button;
// the character-assign picker shows for every officer+.
export function MembersRolesList({
  members,
  selfUserId,
  canEditRoles,
  unclaimedCharacters,
}: {
  members: MemberRow[];
  selfUserId: string;
  canEditRoles: boolean;
  unclaimedCharacters: UnclaimedCharacter[];
}) {
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
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="font-medium">{m.username ?? "(no username)"}</p>
                <p className="text-sm text-neutral-500">
                  {m.discordVerified ? "Discord verified" : "Not Discord-verified"} · joined{" "}
                  {guildDate(m.createdAt)}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-3">
                {unclaimedCharacters.length > 0 && <AssignCharacterControl userId={m.id} characters={unclaimedCharacters} />}
                {canEditRoles && (
                  <>
                    <RemoveMemberButton
                      userId={m.id}
                      username={m.username ?? "this member"}
                      departed={m.playerStatus === "departed"}
                      isSelf={m.id === selfUserId}
                    />
                    <RoleSelect userId={m.id} role={m.role} isSelf={m.id === selfUserId} />
                  </>
                )}
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
