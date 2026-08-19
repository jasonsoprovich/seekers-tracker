"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { SignOutButton } from "./SignOutButton";

interface NavLink {
  href: string;
  label: string;
  badge?: number;
}

function NavBadge({ count }: { count: number }) {
  return (
    <span className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-semibold text-black">
      {count}
    </span>
  );
}

export function NavBar({
  links,
  username,
  avatarUrl,
}: {
  links: NavLink[];
  username: string;
  avatarUrl: string | null;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  function isActive(href: string) {
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  const initials = username.slice(0, 2).toUpperCase();

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-surface/95 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-3">
        <Link href="/characters" className="flex shrink-0 items-center gap-2 text-sm font-bold tracking-tight">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/favicon.svg" alt="" className="h-6 w-6" />
          Seekers of Souls
        </Link>

        <nav className="hidden items-center gap-1 sm:flex">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`flex items-center rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                isActive(link.href) ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:text-neutral-200"
              }`}
            >
              {link.label}
              {!!link.badge && <NavBadge count={link.badge} />}
            </Link>
          ))}
        </nav>

        <div className="relative ml-auto hidden sm:block">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-2 rounded-full border border-field px-2 py-1 text-sm font-medium text-neutral-200 transition-colors hover:border-neutral-500"
          >
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={avatarUrl} alt="" className="h-6 w-6 rounded-full" />
            ) : (
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-neutral-700 text-[10px] font-semibold">
                {initials}
              </span>
            )}
            <span className="max-w-[10rem] truncate">{username}</span>
          </button>
          {menuOpen && (
            <>
              <button
                type="button"
                aria-hidden
                tabIndex={-1}
                onClick={() => setMenuOpen(false)}
                className="fixed inset-0 z-10 cursor-default"
              />
              <div className="absolute right-0 z-20 mt-2 w-44 overflow-hidden rounded-lg border border-border bg-neutral-900 shadow-xl">
                <div className="px-3 py-2 text-xs text-neutral-500">
                  Signed in as
                  <br />
                  <span className="text-neutral-300">{username}</span>
                </div>
                <div className="border-t border-border">
                  <SignOutButton className="block w-full px-3 py-2 text-left text-sm text-neutral-300 transition-colors hover:bg-neutral-800" />
                </div>
              </div>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={() => setMobileOpen((v) => !v)}
          aria-label="Toggle menu"
          className="rounded-md border border-field p-1.5 text-neutral-300 sm:hidden"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 4.5h14M2 9h14M2 13.5h14" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {mobileOpen && (
        <div className="border-t border-border px-6 py-3 sm:hidden">
          <nav className="flex flex-col gap-1">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMobileOpen(false)}
                className={`flex items-center rounded-md px-3 py-2 text-sm font-medium ${
                  isActive(link.href) ? "bg-neutral-800 text-neutral-100" : "text-neutral-400"
                }`}
              >
                {link.label}
                {!!link.badge && <NavBadge count={link.badge} />}
              </Link>
            ))}
          </nav>
          <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
            <span className="text-sm text-neutral-400">{username}</span>
            <SignOutButton className="text-sm font-medium text-neutral-300 hover:text-neutral-100" />
          </div>
        </div>
      )}
    </header>
  );
}
