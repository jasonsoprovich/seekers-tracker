"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

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
  mobile = false,
}: {
  username: string;
  avatarUrl: string | null;
  onSignOutClick?: () => void;
  mobile?: boolean;
}) {
  const initials = username.slice(0, 2).toUpperCase();
  return (
    <div
      className={`flex items-center gap-2 rounded-lg border border-field font-medium text-neutral-200 ${
        mobile ? "px-3 py-3 text-base" : "px-2 py-2 text-sm"
      }`}
    >
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={avatarUrl} alt="" className={`shrink-0 rounded-full ${mobile ? "h-9 w-9" : "h-7 w-7"}`} />
      ) : (
        <span
          className={`flex shrink-0 items-center justify-center rounded-full bg-neutral-700 font-semibold ${
            mobile ? "h-9 w-9 text-xs" : "h-7 w-7 text-[10px]"
          }`}
        >
          {initials}
        </span>
      )}
      <Link href="/profile" className="min-w-0 flex-1 truncate hover:text-emerald-300" title="Profile settings">
        {username}
      </Link>
      <SignOutButton
        onClick={onSignOutClick}
        className={`shrink-0 rounded-md text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200 ${
          mobile ? "flex h-10 min-w-10 items-center justify-center px-2 text-sm" : "px-1.5 py-1 text-xs"
        }`}
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
    const base = `flex items-center gap-2 rounded-md px-3 font-medium transition-colors ${mobile ? "py-3 text-base" : "py-2 text-sm"}`;
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

      {/* Mobile top bar */}
      <header className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-border bg-surface/95 px-4 py-3 backdrop-blur sm:hidden">
        <Logo />
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
          aria-expanded={mobileOpen}
          aria-haspopup="dialog"
          className="flex h-11 w-11 items-center justify-center rounded-md border border-field text-neutral-300"
        >
          <svg width="20" height="20" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 4.5h14M2 9h14M2 13.5h14" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      <MobileNavDrawer
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        links={links}
        linkClasses={linkClasses}
        username={username}
        avatarUrl={avatarUrl}
      />
    </>
  );
}

// Full-viewport modal drawer for the mobile nav, built on the native
// <dialog> element — same choice as ui/ConfirmDialog.tsx (see its own
// comment): showModal()/close() give a real focus trap, Escape handling
// (the "cancel" event, below), and focus restoration to the element that
// opened it, all per the HTML spec, for free — no hand-rolled focus-trap
// logic to get wrong. Kept mounted at all times (visibility toggled via
// the imperative dialog API, not conditional rendering) so its own effect
// is the only thing driving open/close.
function MobileNavDrawer({
  open,
  onClose,
  links,
  linkClasses,
  username,
  avatarUrl,
}: {
  open: boolean;
  onClose: () => void;
  links: NavLinkItem[];
  linkClasses: (href: string, mobile?: boolean) => string;
  username: string;
  avatarUrl: string | null;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-label="Menu"
      onCancel={(e) => {
        // Escape fires the native "cancel" event — handle it explicitly so
        // our own `open` state stays in sync with the dialog's real state.
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
      className="m-0 h-dvh max-h-none w-full max-w-none border-0 bg-surface p-0 text-neutral-100 backdrop:bg-black/60 sm:hidden"
    >
      <div className="flex h-full flex-col gap-4 px-4 py-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <Logo />
          <button
            type="button"
            autoFocus
            onClick={onClose}
            aria-label="Close menu"
            className="flex h-11 w-11 items-center justify-center rounded-md border border-field text-neutral-300"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M3 3l12 12M15 3L3 15" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto">
          {links.map((link) => (
            <Link key={link.href} href={link.href} onClick={onClose} className={linkClasses(link.href, true)}>
              {link.label}
              {!!link.badge && <NavBadge count={link.badge} />}
            </Link>
          ))}
        </nav>
        <AccountBlock username={username} avatarUrl={avatarUrl} onSignOutClick={onClose} mobile />
      </div>
    </dialog>
  );
}
