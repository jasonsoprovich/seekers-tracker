export function SegmentedToggle({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="flex overflow-hidden rounded-full border border-field text-xs">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`px-3 py-1 font-medium transition-colors ${
            value === opt.value ? "bg-neutral-700 text-neutral-100" : "text-neutral-400 hover:text-neutral-200"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
