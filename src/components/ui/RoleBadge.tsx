import type { Role } from "@/lib/authz";

const STYLES: Record<Role, string> = {
  admin: "border-violet-700 bg-violet-950/40 text-violet-400",
  leader: "border-amber-700 bg-amber-950/40 text-amber-400",
  officer: "border-sky-700 bg-sky-950/40 text-sky-400",
  member: "border-neutral-700 bg-neutral-800/40 text-neutral-500",
};

const LABELS: Record<Role, string> = {
  admin: "Admin",
  leader: "Guild Leader",
  officer: "Officer",
  member: "Member",
};

// Lower rank sorts first — admin, then leader, then officer, then member —
// so a "find officers" sort on role reads as a privilege ladder, not
// alphabetical noise. Admin outranks leader here since it's site/dev
// administration, not guild-loot authority — see src/lib/authz.ts.
const RANK: Record<Role, number> = { admin: 0, leader: 1, officer: 2, member: 3 };

export function roleRank(role: Role): number {
  return RANK[role];
}

export function RoleBadge({ role, className = "" }: { role: Role; className?: string }) {
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase ${STYLES[role]} ${className}`}>
      {LABELS[role]}
    </span>
  );
}
