import Image from "next/image";
import Link from "next/link";

const DISCORD_INVITE_URL = "https://discord.gg/Xzb75CvcMH";

function DiscordCTA({ className = "" }: { className?: string }) {
  return (
    <a
      href={DISCORD_INVITE_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center justify-center gap-2 rounded-full bg-emerald-500 px-6 py-3 font-semibold text-black transition-colors hover:bg-emerald-400 ${className}`}
    >
      Join us on Discord
    </a>
  );
}

const aboutPoints = [
  "Play what you love — no forced classes",
  "Community first — helpful, respectful, drama-free",
  "Veterans and newcomers welcome alike",
  "A guild where people matter more than pixels",
];

const eventPoints = [
  "2–3 guild events each week",
  "Typical raid times: 9:00 PM – 12:00 AM EST",
  "Flexible scheduling built around our members",
  "Progression, epics, quests, XP groups, and more",
];

const progression = ["Classic", "Kunark", "Velious", "Luclin"];

const whoWeSeek = [
  "Respectful, team-oriented players",
  "People who want to contribute to a positive community",
  "Casual and hardcore players alike",
  "Players looking for a long-term home, not just a tag above their head",
];

export default function Home() {
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
        <span className="text-lg font-bold tracking-tight">Seekers of Souls</span>
        <div className="flex items-center gap-3">
          <Link
            href="/login"
            className="rounded-full border border-neutral-700 px-4 py-2 text-sm font-medium transition-colors hover:border-emerald-500 hover:text-emerald-400"
          >
            Member Login
          </Link>
          <a
            href={DISCORD_INVITE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border border-neutral-700 px-4 py-2 text-sm font-medium transition-colors hover:border-emerald-500 hover:text-emerald-400"
          >
            Discord
          </a>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto flex max-w-5xl flex-col items-center gap-10 px-6 py-12 text-center md:flex-row md:text-left">
        <div className="flex-1">
          <p className="text-sm font-semibold tracking-widest text-emerald-400 uppercase">
            A Project Quarm Guild
          </p>
          <h1 className="mt-3 text-4xl font-extrabold tracking-tight sm:text-5xl">Seekers of Souls</h1>
          <p className="mt-4 text-xl text-neutral-300">Good Souls &gt; Parses.</p>
          <p className="mt-4 text-neutral-400">
            Seeking raiders, adventurers, and good people. We also love new players. Whether you&apos;re a
            seasoned veteran looking for your next raid home or a brand-new player taking your first steps
            into Norrath, you&apos;ll find a place here.
          </p>
          <div className="mt-8 flex flex-col items-center gap-4 sm:flex-row md:justify-start">
            <DiscordCTA />
            <span className="text-sm text-neutral-500">A short, informal interview is required.</span>
          </div>
        </div>
        <div className="flex-shrink-0">
          <Image
            src="/images/seekers-banner.png"
            alt="Seekers of Souls"
            width={320}
            height={480}
            className="rounded-2xl border border-neutral-800 shadow-2xl"
            priority
          />
        </div>
      </section>

      {/* Philosophy */}
      <section className="border-t border-neutral-900 bg-neutral-900/40">
        <div className="mx-auto max-w-5xl px-6 py-14">
          <h2 className="text-2xl font-bold">Our philosophy is simple</h2>
          <div className="mt-6 grid grid-cols-2 gap-6 sm:grid-cols-4">
            {[
              ["⚔️", "Have fun"],
              ["🏆", "Earn your loot"],
              ["🤝", "Build lasting friendships"],
              ["🌟", "Leave a legacy of respect"],
            ].map(([icon, label]) => (
              <div key={label} className="text-center">
                <div className="text-3xl">{icon}</div>
                <div className="mt-2 font-medium text-neutral-200">{label}</div>
              </div>
            ))}
          </div>
          <p className="mt-8 text-neutral-400">
            We don&apos;t measure our members by parses. We measure them by character.
          </p>
        </div>
      </section>

      {/* What we're about / Raids */}
      <section className="mx-auto grid max-w-5xl gap-12 px-6 py-14 sm:grid-cols-2">
        <div>
          <h2 className="text-2xl font-bold">What We&apos;re About</h2>
          <ul className="mt-4 space-y-3 text-neutral-300">
            {aboutPoints.map((point) => (
              <li key={point} className="flex gap-3">
                <span className="text-emerald-400">•</span>
                {point}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h2 className="text-2xl font-bold">Raids &amp; Events</h2>
          <ul className="mt-4 space-y-3 text-neutral-300">
            {eventPoints.map((point) => (
              <li key={point} className="flex gap-3">
                <span className="text-emerald-400">•</span>
                {point}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Quest board */}
      <section className="border-t border-neutral-900 bg-neutral-900/40">
        <div className="mx-auto max-w-5xl px-6 py-14">
          <h2 className="text-2xl font-bold">The Seeker&apos;s Player Quest Board</h2>
          <p className="mt-4 max-w-2xl text-neutral-400">
            One of our favorite guild features is our player-driven Quest Board. Need help with an epic?
            Looking for a group? Want to organize a camp, key, quest, or custom event? Post it on the
            board. If you need it, the guild shows up.
          </p>
        </div>
      </section>

      {/* Progression */}
      <section className="mx-auto max-w-5xl px-6 py-14">
        <h2 className="text-2xl font-bold">Progression</h2>
        <div className="mt-4 flex flex-wrap gap-3">
          {progression.map((era) => (
            <span
              key={era}
              className="flex items-center gap-2 rounded-full border border-emerald-800 bg-emerald-950 px-4 py-2 text-sm font-medium text-emerald-300"
            >
              <span aria-hidden>✔</span>
              {era} Cleared
            </span>
          ))}
        </div>
      </section>

      {/* Who we seek */}
      <section className="border-t border-neutral-900 bg-neutral-900/40">
        <div className="mx-auto max-w-5xl px-6 py-14">
          <h2 className="text-2xl font-bold">Who We Seek</h2>
          <ul className="mt-4 grid gap-3 text-neutral-300 sm:grid-cols-2">
            {whoWeSeek.map((point) => (
              <li key={point} className="flex gap-3">
                <span className="text-emerald-400">•</span>
                {point}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Final CTA */}
      <section className="mx-auto max-w-5xl px-6 py-20 text-center">
        <h2 className="text-3xl font-extrabold">Join the Circle</h2>
        <p className="mx-auto mt-4 max-w-xl text-neutral-400">
          Looking for a guild that has your back, celebrates your successes, and helps you achieve your
          goals? Come see what we&apos;re about.
        </p>
        <div className="mt-8">
          <DiscordCTA />
        </div>
        <p className="mt-10 text-sm font-semibold tracking-widest text-neutral-500 uppercase">
          Quality &gt; Quantity — Always
        </p>
      </section>

      <footer className="border-t border-neutral-900 px-6 py-8 text-center text-sm text-neutral-600">
        Seekers of Souls — a Project Quarm guild.
      </footer>
    </div>
  );
}
