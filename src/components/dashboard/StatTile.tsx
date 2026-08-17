import { Card } from "@/components/ui/Card";

export function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <Card className="px-4 py-3">
      <p className="text-xs tracking-wider text-neutral-500 uppercase">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-neutral-100">{value}</p>
    </Card>
  );
}
