"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/Button";

type CollectingDetail = "full" | "limited" | "none";
type ConfigResponse = { collectingDetail: CollectingDetail; error?: string };

const OPTIONS: { value: CollectingDetail; label: string; description: string }[] = [
  { value: "full", label: "Full detail", description: "Show live bidder names, bids, and priority." },
  { value: "limited", label: "Limited", description: "Show only each item's current bid count." },
  { value: "none", label: "No detail", description: "Show only that bidding is open." },
];

export function LiveBidVisibilityControl() {
  const [collectingDetail, setCollectingDetail] = useState<CollectingDetail | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/live-bids/config")
      .then(async (response) => {
        const body = (await response.json()) as ConfigResponse;
        if (!response.ok) throw new Error(body.error || "Could not load live-bid visibility.");
        if (!cancelled) setCollectingDetail(body.collectingDetail);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load live-bid visibility.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function updateDetail(next: CollectingDetail) {
    if (collectingDetail === null || next === collectingDetail) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/live-bids/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collectingDetail: next }),
      });
      const body = (await response.json()) as ConfigResponse;
      if (!response.ok) throw new Error(body.error || "Could not update live-bid visibility.");
        setCollectingDetail(body.collectingDetail);
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
          <h3 className="font-medium text-neutral-200">Live bid detail</h3>
          <p className="mt-1 text-sm text-neutral-400">
            Choose how much members see while a round is collecting. Finalized rounds always show the winner and complete bid history.
          </p>
          {collectingDetail !== null && (
            <p className="mt-2 text-xs font-medium text-emerald-400" aria-live="polite">
              {OPTIONS.find((option) => option.value === collectingDetail)?.label} is active.
            </p>
          )}
          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {OPTIONS.map((option) => (
            <Button
              key={option.value}
              type="button"
              variant={collectingDetail === option.value ? "primary" : "outline"}
              size="sm"
              disabled={collectingDetail === null || saving}
              onClick={() => void updateDetail(option.value)}
              title={option.description}
            >
              {saving && collectingDetail !== option.value ? "Saving..." : option.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
