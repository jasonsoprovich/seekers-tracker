"use client";

import { useEffect } from "react";

import { handleChunkLoadError } from "@/lib/chunk-reload";

// Segment-level boundary for the authed app. Renders inside AppShell (the
// (app) layout sits above this boundary), so a page-level render error
// doesn't blank the whole window. Same deploy-skew handling as
// global-error.tsx: a stale-chunk error auto-reloads once onto the current
// build; anything else shows a recoverable card.
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    handleChunkLoadError(error);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-lg font-bold text-neutral-100">This page hit an error</h1>
      <p className="max-w-sm text-sm text-neutral-400">
        Reloading usually clears it. If it keeps happening, let a leader know.
      </p>
      <div className="mt-2 flex gap-3">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-full bg-emerald-500 px-5 py-2 text-sm font-semibold text-black transition-colors hover:bg-emerald-400"
        >
          Reload
        </button>
        <button
          type="button"
          onClick={() => reset()}
          className="rounded-full border border-neutral-700 px-5 py-2 text-sm font-semibold text-neutral-200 transition-colors hover:border-neutral-500"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
