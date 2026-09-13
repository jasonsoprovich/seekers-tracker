"use client";

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

  async function signIn() {
    setPending(true);
    setError(false);
    try {
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
