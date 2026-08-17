import type { LabelHTMLAttributes, ReactNode } from "react";

// Matches the three input treatments in use: a normal field (CharacterForm),
// a monospace field for the paste-box imports, and a compact field for
// inline controls like RoleSelect's role picker.
export function fieldClasses({ size = "md", mono = false }: { size?: "sm" | "md"; mono?: boolean } = {}) {
  const padding = size === "sm" ? "px-2 py-1 text-sm" : mono ? "px-3 py-2 font-mono text-sm" : "px-3 py-2";
  return `rounded-md border border-field bg-neutral-900 text-neutral-100 focus:border-accent focus:outline-none ${padding}`;
}

export function Field({ children, className = "", ...props }: LabelHTMLAttributes<HTMLLabelElement> & { children: ReactNode }) {
  return (
    <label {...props} className={`flex flex-col gap-1 text-sm ${className}`}>
      {children}
    </label>
  );
}
