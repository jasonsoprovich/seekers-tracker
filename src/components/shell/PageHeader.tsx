import Link from "next/link";
import type { ReactNode } from "react";

export interface Crumb {
  label: string;
  href?: string;
}

export function PageHeader({
  breadcrumbs,
  title,
  subtitle,
  actions,
}: {
  breadcrumbs?: Crumb[];
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-8">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav className="mb-2 flex flex-wrap items-center gap-1.5 text-sm text-neutral-500">
          {breadcrumbs.map((crumb, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-neutral-700">/</span>}
              {crumb.href ? (
                <Link href={crumb.href} className="hover:text-neutral-300">
                  {crumb.label}
                </Link>
              ) : (
                <span className="text-neutral-300">{crumb.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-neutral-100">{title}</h1>
          {subtitle && <div className="mt-1 text-sm text-neutral-400">{subtitle}</div>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-4 text-sm font-medium">{actions}</div>}
      </div>
    </div>
  );
}
