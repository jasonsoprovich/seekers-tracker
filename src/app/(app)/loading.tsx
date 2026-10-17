// Instant feedback for in-app navigation. Without this, clicking a sidebar
// link showed nothing at all until the next page's server render (session
// check + its D1 queries) had finished. The shell (sidebar, header) stays
// put; only the content area swaps to this placeholder while it loads.
export default function AppLoading() {
  return (
    <div className="mx-auto max-w-3xl animate-pulse" aria-busy="true" aria-label="Loading">
      <div className="mb-2 h-7 w-56 rounded bg-neutral-800" />
      <div className="mb-8 h-4 w-80 max-w-full rounded bg-neutral-900" />
      <div className="space-y-3">
        <div className="h-16 rounded-lg bg-neutral-900" />
        <div className="h-16 rounded-lg bg-neutral-900" />
        <div className="h-16 rounded-lg bg-neutral-900" />
      </div>
    </div>
  );
}
