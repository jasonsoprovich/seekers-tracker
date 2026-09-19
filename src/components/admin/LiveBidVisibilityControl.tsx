"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/Button";

type ConfigResponse = { showCollecting: boolean; error?: string };

export function LiveBidVisibilityControl() {
  const [showCollecting, setShowCollecting] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/live-bids/config")
      .then(async (response) => {
        const body = (await response.json()) as ConfigResponse;
        if (!response.ok) throw new Error(body.error || "Could not load live-bid visibility.");
        if (!cancelled) setShowCollecting(body.showCollecting);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load live-bid visibility.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function updateVisibility() {
    if (showCollecting === null) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/live-bids/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ showCollecting: !showCollecting }),
      });
      const body = (await response.json()) as ConfigResponse;
      if (!response.ok) throw new Error(body.error || "Could not update live-bid visibility.");
      setShowCollecting(body.showCollecting);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update live-bid visibility.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-6 rounded-lg border border-border bg-panel p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h3 className="font-medium text-neutral-200">Live collecting rounds</h3>
          <p className="mt-1 text-sm text-neutral-400">
            Hide open rounds from the member REST and WebSocket feeds when bids need to stay private. Collection and persistence continue,
            and finalized results always remain visible.
          </p>
          {showCollecting !== null && (
            <p className={`mt-2 text-xs font-medium ${showCollecting ? "text-emerald-400" : "text-amber-400"}`} aria-live="polite">
              {showCollecting ? "Collecting rounds are visible." : "Collecting rounds are hidden; resolved rounds are still visible."}
            </p>
          )}
          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={showCollecting === null || saving}
          onClick={updateVisibility}
          aria-label={showCollecting ? "Hide collecting rounds" : "Show collecting rounds"}
        >
          {saving ? "Saving..." : showCollecting === null ? "Loading..." : showCollecting ? "Hide collecting" : "Show collecting"}
        </Button>
      </div>
    </div>
  );
}
