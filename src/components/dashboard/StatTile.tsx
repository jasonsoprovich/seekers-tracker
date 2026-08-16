export function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-3">
      <p className="text-xs tracking-wider text-neutral-500 uppercase">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-neutral-100">{value}</p>
    </div>
  );
}
