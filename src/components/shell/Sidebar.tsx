"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { SignOutButton } from "./SignOutButton";

export interface NavLinkItem {
  href: string;
  label: string;
  badge?: number;
}

function NavBadge({ count }: { count: number }) {
  return (
    <span className="ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-semibold text-black">
      {count}
    </span>
  );
}

function Logo() {
  return (
    <Link href="/characters" className="flex shrink-0 items-center gap-2 text-sm font-bold tracking-tight">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/favicon.svg" alt="" className="h-6 w-6" />
      Seekers of Souls
    </Link>
  );
}

function AccountBlock({
  username,
  avatarUrl,
  onSignOutClick,
}: {
  username: string;
  avatarUrl: string | null;
  onSignOutClick?: () => void;
}) {
  const initials = username.slice(0, 2).toUpperCase();
  return (
    <div className="flex items-center gap-2 rounded-lg border border-field px-2 py-2 text-sm font-medium text-neutral-200">
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={avatarUrl} alt="" className="h-7 w-7 shrink-0 rounded-full" />
      ) : (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-700 text-[10px] font-semibold">{initials}</span>
      )}
      <span className="min-w-0 flex-1 truncate">{username}</span>
      <SignOutButton
        onClick={onSignOutClick}
        className="shrink-0 rounded-md px-1.5 py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
      />
    </div>
  );
}

// Left sidebar: logo pinned at top, nav links scrollable in the middle
// (only matters once the link list outgrows the viewport — harmless at
// today's ~8 links, cheap to have for whenever a future phase adds more),
// account block pinned at the bottom. `sticky top-0 h-screen` rather than
// `position: fixed` — stays pinned while `<main>` scrolls the normal page
// scroll, no separate nested scroll container to fight browser
// find-in-page or momentum scroll.
export function Sidebar({ links, username, avatarUrl }: { links: NavLinkItem[]; username: string; avatarUrl: string | null }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  function isActive(href: string) {
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  function linkClasses(href: string, mobile = false) {
    const base = `flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${mobile ? "" : ""}`;
    return `${base} ${isActive(href) ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"}`;
  }

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col gap-4 border-r border-border bg-surface px-4 py-5 sm:flex">
        <Logo />
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto">
          {links.map((link) => (
            <Link key={link.href} href={link.href} className={linkClasses(link.href)}>
              {link.label}
              {!!link.badge && <NavBadge count={link.badge} />}
            </Link>
          ))}
        </nav>
        <AccountBlock username={username} avatarUrl={avatarUrl} />
      </aside>

      {/* Mobile top bar + drawer */}
      <header className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-border bg-surface/95 px-4 py-3 backdrop-blur sm:hidden">
        <Logo />
        <button
          type="button"
          onClick={() => setMobileOpen((v) => !v)}
          aria-label="Toggle menu"
          aria-expanded={mobileOpen}
          className="rounded-md border border-field p-1.5 text-neutral-300"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 4.5h14M2 9h14M2 13.5h14" strokeLinecap="round" />
          </svg>
        </button>
      </header>
      {mobileOpen && (
        <div className="border-b border-border px-4 py-3 sm:hidden">
          <nav className="flex flex-col gap-1">
            {links.map((link) => (
              <Link key={link.href} href={link.href} onClick={() => setMobileOpen(false)} className={linkClasses(link.href, true)}>
                {link.label}
                {!!link.badge && <NavBadge count={link.badge} />}
              </Link>
            ))}
          </nav>
          <div className="mt-3 border-t border-border pt-3">
            <AccountBlock username={username} avatarUrl={avatarUrl} onSignOutClick={() => setMobileOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}
