import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "outline";
type Size = "sm" | "md" | "lg";

const sizeClasses: Record<Size, string> = {
  sm: "px-3 py-1 text-xs",
  md: "px-4 py-2 text-sm",
  lg: "px-6 py-3",
};

const variantClasses: Record<Variant, string> = {
  primary: "bg-accent font-semibold text-black transition-colors hover:bg-accent-hover disabled:opacity-60",
  outline:
    "border border-field font-medium transition-colors hover:border-accent hover:text-accent-hover disabled:opacity-60",
};

function classes(variant: Variant, size: Size, className: string) {
  return `inline-flex items-center justify-center gap-2 rounded-full ${sizeClasses[size]} ${variantClasses[variant]} ${className}`;
}

export function Button({
  variant = "primary",
  size = "lg",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return <button {...props} className={classes(variant, size, className)} />;
}

export function LinkButton({
  href,
  variant = "outline",
  size = "md",
  className = "",
  children,
}: {
  href: string;
  variant?: Variant;
  size?: Size;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={classes(variant, size, className)}>
      {children}
    </Link>
  );
}
