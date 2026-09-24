"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { DEFAULT_SIGN_IN_DESTINATION, sanitizeSignInDestination } from "@/lib/auth-redirect";
import { authClient } from "@/lib/auth-client";

type DiscordSignInButtonProps = {
  callbackURL?: string;
  className?: string;
  label?: string;
  pendingLabel?: string;
};

export function DiscordSignInButton({
  callbackURL = DEFAULT_SIGN_IN_DESTINATION,
  className,
  label = "Sign in with Discord",
  pendingLabel = "Redirecting...",
}: DiscordSignInButtonProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const router = useRouter();

  // 2026-09-23 (post-live-test-1 feedback): clicking this on the homepage
  // always kicked off a brand-new Discord OAuth round trip, even for a
  // visitor who was already signed in — the existing session was never
  // lost (/roster etc. kept working the whole time), this button just never
  // checked for one first. `prompt: "consent"` (src/auth/index.ts) then
  // makes Discord show its Authorize screen on every one of those
  // unnecessary round trips. A real navigation, not router.refresh() —
  // this component renders on the public landing page, outside the
  // authenticated layout that would otherwise pick up the session.
  async function signIn() {
    setPending(true);
    setError(false);
    try {
      const { data } = await authClient.getSession();
      if (data) {
        router.push(sanitizeSignInDestination(callbackURL));
        return;
      }
      await authClient.signIn.social({
        provider: "discord",
        callbackURL: sanitizeSignInDestination(callbackURL),
      });
    } catch {
      setPending(false);
      setError(true);
    }
  }

  return (
    <>
      <button type="button" onClick={signIn} disabled={pending} className={className}>
        {pending ? pendingLabel : label}
      </button>
      {error && (
        <span className="sr-only" role="alert">
          Discord sign-in could not start. Please try again.
        </span>
      )}
    </>
  );
}
