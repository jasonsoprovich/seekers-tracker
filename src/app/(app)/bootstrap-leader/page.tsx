import { redirect } from "next/navigation";

import { ClaimLeaderButton } from "@/components/ClaimLeaderButton";
import { hasAnyLeader } from "@/lib/authz";
import { getSession } from "@/lib/session";

export default async function BootstrapLeaderPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  // hasAnyLeader() treats leader and admin as equivalent leadership — see
  // its own comment. Using the same check here (rather than this page's
  // former standalone role='leader' query) closes the gap where a guild
  // whose only privileged account had been promoted to admin would show
  // this self-claim flow to anyone.
  if (await hasAnyLeader()) {
    return (
      <div className="mx-auto flex max-w-sm flex-col items-center gap-2 py-16 text-center">
        <h1 className="text-xl font-bold">A leader already exists</h1>
        <p className="text-neutral-400">Ask an existing leader or admin to promote you from the Admin panel.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-2 py-16 text-center">
      <h1 className="text-xl font-bold">Claim the leader role</h1>
      <p className="text-neutral-400">
        No one leads Seekers of Souls yet. As the first person here, you can claim the leader role to bootstrap role
        management — you&apos;ll be able to promote others from Admin afterward.
      </p>
      <div className="mt-4">
        <ClaimLeaderButton />
      </div>
    </div>
  );
}
