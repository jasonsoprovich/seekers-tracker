import Link from "next/link";

export function EmptyState({
  message,
  linkHref,
  linkLabel,
  suffix = "",
}: {
  message: string;
  linkHref?: string;
  linkLabel?: string;
  suffix?: string;
}) {
  return (
    <p className="text-sm text-neutral-400">
      {message}
      {linkHref && linkLabel && (
        <>
          {" "}
          <Link href={linkHref} className="text-emerald-400 hover:text-emerald-300">
            {linkLabel}
          </Link>
          {suffix}
        </>
      )}
    </p>
  );
}
