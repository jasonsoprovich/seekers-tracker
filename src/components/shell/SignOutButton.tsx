"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";

export function SignOutButton({ className = "", onClick: onClickExtra }: { className?: string; onClick?: () => void }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onClick() {
    onClickExtra?.();
    setPending(true);
    await authClient.signOut();
    router.push("/");
    router.refresh();
  }

  return (
    <button type="button" onClick={onClick} disabled={pending} className={className}>
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
