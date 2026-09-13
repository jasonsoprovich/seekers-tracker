import Link from "next/link";

import { DiscordSignInButton } from "@/components/auth/DiscordSignInButton";
import { sanitizeSignInDestination } from "@/lib/auth-redirect";

type LoginSearchParams = { next?: string | string[] };

export default async function LoginPage({ searchParams }: { searchParams: Promise<LoginSearchParams> }) {
  const { next } = await searchParams;
  const destination = sanitizeSignInDestination(next);

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-[#090b07] px-6 text-center text-[#d8cda6]">
      <div
        aria-hidden="true"
        className="absolute top-[-10rem] left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-[#74851d]/15 blur-3xl"
      />
      <Link
        href="/"
        className="absolute top-6 left-6 min-h-11 content-center text-sm font-medium text-[#8f8c77] hover:text-[#e0b957]"
      >
        &larr; Back to site
      </Link>
      <section className="relative w-full max-w-md border border-[#b8903c]/35 bg-[#10140d]/90 px-6 py-10 shadow-2xl sm:px-10">
        <p className="text-xs font-bold tracking-[0.25em] text-[#74851d] uppercase">Member access</p>
        <h1 className="mt-3 font-serif text-4xl font-normal tracking-tight text-[#eee1b9]">Seekers of Souls</h1>
        <p className="mt-4 text-sm leading-6 text-[#9d987f]">
          Sign in through the guild Discord to continue to the roster and character tools.
        </p>
        <DiscordSignInButton
          callbackURL={destination}
          className="mt-7 inline-flex min-h-12 w-full items-center justify-center border border-[#d4a942] bg-[#b8903c] px-6 font-bold tracking-wide text-[#111307] transition-colors hover:bg-[#e0b957] disabled:cursor-wait disabled:opacity-60"
        />
        <p className="mt-6 text-xs leading-5 text-[#747461]">
          You must be a verified member of the Seekers of Souls Discord server to enter.
        </p>
      </section>
    </main>
  );
}
