export function Card({ className = "", children }: { className?: string; children: React.ReactNode }) {
  return <div className={`rounded-lg border border-border bg-panel ${className}`}>{children}</div>;
}
