"use client";

import Link from "next/link";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";

export default function LoginPage() {
  const [pending, setPending] = useState(false);

  async function signIn() {
    setPending(true);
    await authClient.signIn.social({ provider: "discord", callbackURL: "/characters" });
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center gap-6 bg-neutral-950 px-6 text-center text-neutral-100">
      <Link
        href="/"
        className="absolute top-6 left-6 text-sm font-medium text-neutral-500 hover:text-neutral-300"
      >
        ← Back to site
      </Link>
      <div>
        <h1 className="text-2xl font-bold">Seekers of Souls</h1>
        <p className="mt-2 text-neutral-400">Sign in with your Discord account to manage your characters.</p>
      </div>
      <button
        onClick={signIn}
        disabled={pending}
        className="inline-flex items-center justify-center gap-2 rounded-full bg-emerald-500 px-6 py-3 font-semibold text-black transition-colors hover:bg-emerald-400 disabled:opacity-60"
      >
        {pending ? "Redirecting…" : "Sign in with Discord"}
      </button>
      <p className="max-w-sm text-sm text-neutral-500">
        You must be a member of the Seekers of Souls Discord server to access the roster tracker.
      </p>
    </div>
  );
}
