import type { LabelHTMLAttributes, ReactNode } from "react";

// Matches the three input treatments in use: a normal field (CharacterForm),
// a monospace field for the paste-box imports, and a compact field for
// inline controls like RoleSelect's role picker.
//
// text-base sm:text-sm (not a flat text-sm) below 640px: iOS Safari zooms
// the whole page in on focus for any text input under 16px, and every one
// of these fields sits inside an ambient text-sm container, so a bare
// text-sm on the input itself would trigger that zoom on every phone.
export function fieldClasses({ size = "md", mono = false }: { size?: "sm" | "md"; mono?: boolean } = {}) {
  const padding =
    size === "sm" ? "px-2 py-1 text-base sm:text-sm" : mono ? "px-3 py-2 font-mono text-base sm:text-sm" : "px-3 py-2 text-base sm:text-sm";
  return `rounded-md border border-field bg-neutral-900 text-neutral-100 focus:border-accent focus:outline-none ${padding}`;
}

export function Field({ children, className = "", ...props }: LabelHTMLAttributes<HTMLLabelElement> & { children: ReactNode }) {
  return (
    <label {...props} className={`flex flex-col gap-1 text-sm ${className}`}>
      {children}
    </label>
  );
}
