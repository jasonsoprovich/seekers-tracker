import Link from "next/link";

// Numbered page links: « Prev 1 2 3 … 45 46 Next ». Always shows the first
// and last page, the current page ±2, and ellipses for the gaps. Server-
// renderable (plain links), so every page is a bookmarkable URL.
function pageList(page: number, totalPages: number): (number | "gap")[] {
  const keep = new Set<number>([1, totalPages]);
  for (let p = page - 2; p <= page + 2; p++) if (p >= 1 && p <= totalPages) keep.add(p);
  const sorted = [...keep].sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push("gap");
    out.push(p);
  });
  return out;
}

const base = "min-w-9 rounded-md border px-2.5 py-1.5 text-center text-sm font-medium";

export function Pagination({
  page,
  totalPages,
  total,
  hrefFor,
}: {
  page: number;
  totalPages: number;
  total: number;
  hrefFor: (page: number) => string;
}) {
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <span className="text-neutral-500">
        Page {page} of {totalPages} · {total.toLocaleString()} rows
      </span>
      {totalPages > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {page > 1 ? (
            <Link href={hrefFor(page - 1)} prefetch={false} className={`${base} border-field text-neutral-300 hover:bg-neutral-900/60`}>
              ← Prev
            </Link>
          ) : (
            <span className={`${base} border-transparent text-neutral-600`}>← Prev</span>
          )}
          {pageList(page, totalPages).map((p, i) =>
            p === "gap" ? (
              <span key={`gap-${i}`} className="px-1 text-neutral-600">
                …
              </span>
            ) : p === page ? (
              <span key={p} aria-current="page" className={`${base} border-accent bg-accent text-black`}>
                {p}
              </span>
            ) : (
              <Link key={p} href={hrefFor(p)} prefetch={false} className={`${base} border-field text-neutral-300 hover:bg-neutral-900/60`}>
                {p}
              </Link>
            ),
          )}
          {page < totalPages ? (
            <Link href={hrefFor(page + 1)} prefetch={false} className={`${base} border-field text-neutral-300 hover:bg-neutral-900/60`}>
              Next →
            </Link>
          ) : (
            <span className={`${base} border-transparent text-neutral-600`}>Next →</span>
          )}
        </div>
      )}
    </nav>
  );
}
