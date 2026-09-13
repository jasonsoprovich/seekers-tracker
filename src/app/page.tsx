import Image from "next/image";
import Link from "next/link";

import { DiscordSignInButton } from "@/components/auth/DiscordSignInButton";

import styles from "./public.module.css";

const DISCORD_INVITE_URL = "https://discord.gg/Xzb75CvcMH";

const progression = ["Classic", "Kunark", "Velious", "Luclin"];

function DiscordInvite({ compact = false }: { compact?: boolean }) {
  return (
    <a
      href={DISCORD_INVITE_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={compact ? styles.textLink : styles.primaryCta}
    >
      Join our Discord
      <span aria-hidden="true">&rarr;</span>
    </a>
  );
}

export default function Home() {
  return (
    <main className={styles.page}>
      <a className={styles.skipLink} href="#guild-story">
        Skip to guild information
      </a>

      <header className={styles.header}>
        <Link className={styles.wordmark} href="/" aria-label="Seekers of Souls home">
          <span className={styles.sigil} aria-hidden="true">S</span>
          <span>
            <strong>Seekers of Souls</strong>
            <small>Project Quarm</small>
          </span>
        </Link>
        <nav className={styles.headerActions} aria-label="Public navigation">
          <DiscordInvite compact />
          <DiscordSignInButton className={styles.memberLink} label="Member sign in" />
        </nav>
      </header>

      <section className={styles.hero} aria-labelledby="hero-heading">
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>A Project Quarm guild</p>
          <h1 id="hero-heading">Good souls leave a lasting mark.</h1>
          <p className={styles.lede}>
            Seekers of Souls is a community-first home for raiders, adventurers, and new players finding
            their footing in Norrath.
          </p>
          <div className={styles.heroActions}>
            <DiscordInvite />
            <p>A short, informal interview is required.</p>
          </div>
          <dl className={styles.raidFacts} aria-label="Guild raid facts">
            <div>
              <dt>Schedule</dt>
              <dd>2-3 nights weekly</dd>
            </div>
            <div>
              <dt>Raid time</dt>
              <dd>9 PM - midnight EST</dd>
            </div>
            <div>
              <dt>Current era</dt>
              <dd>Luclin cleared</dd>
            </div>
          </dl>
        </div>

        <figure className={styles.heroArt}>
          <div className={styles.artHalo} aria-hidden="true" />
          <Image
            src="/images/seekers-banner.webp"
            alt="Seekers of Souls members gathered before a glowing Norrath portal"
            fill
            priority
            fetchPriority="high"
            sizes="(max-width: 767px) 92vw, (max-width: 1200px) 44vw, 520px"
          />
          <figcaption>Community first. Solid raids. All are welcome.</figcaption>
        </figure>
      </section>

      <section id="guild-story" className={styles.story} aria-labelledby="story-heading">
        <div className={styles.sectionNumber} aria-hidden="true">I</div>
        <div className={styles.storyHeading}>
          <p className={styles.eyebrow}>The guild</p>
          <h2 id="story-heading">People before pixels.</h2>
        </div>
        <div className={styles.storyCopy}>
          <p>
            We do not measure members by parses. We measure them by character: how they show up, help
            others, and make the guild a better place to spend an evening.
          </p>
          <p>
            Play what you love. Veterans and first-time adventurers belong at the same campfire, and
            progress means more when the whole guild gets there together.
          </p>
        </div>
      </section>

      <section className={styles.questSection} aria-labelledby="quest-heading">
        <div className={styles.questBoard}>
          <div className={styles.questPin} aria-hidden="true" />
          <p className={styles.questKicker}>A Seekers tradition</p>
          <h2 id="quest-heading">The Player Quest Board</h2>
          <p>
            Need help with an epic? Looking for a camp, key, XP group, or custom event? Put it on the
            board. Members choose the adventures that matter to them, and the guild shows up.
          </p>
          <blockquote>&ldquo;If you need it, we seek it together.&rdquo;</blockquote>
        </div>
        <aside className={styles.questAside} aria-label="Quest Board examples">
          <p className={styles.eyebrow}>Pinned this week</p>
          <ul>
            <li><span>01</span> Epic fights and turn-ins</li>
            <li><span>02</span> Key camps and progression flags</li>
            <li><span>03</span> Member-led events and XP groups</li>
          </ul>
        </aside>
      </section>

      <section className={styles.progressionSection} aria-labelledby="progression-heading">
        <div>
          <p className={styles.eyebrow}>The road traveled</p>
          <h2 id="progression-heading">Focused progression.<br />Relaxed company.</h2>
        </div>
        <ol className={styles.progressionList}>
          {progression.map((era, index) => (
            <li key={era}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{era}</strong>
              <small>Cleared</small>
            </li>
          ))}
        </ol>
      </section>

      <section className={styles.recruitment} aria-labelledby="recruitment-heading">
        <p className={styles.eyebrow}>Who we seek</p>
        <h2 id="recruitment-heading">Bring your favorite class.<br />Bring the right spirit.</h2>
        <p>
          We welcome casual and dedicated players who are respectful, team-oriented, and looking for a
          long-term home rather than another tag above their head.
        </p>
        <div className={styles.recruitmentActions}>
          <DiscordInvite />
          <span>Quality over quantity, always.</span>
        </div>
      </section>

      <footer className={styles.footer}>
        <span>Seekers of Souls</span>
        <span>Project Quarm</span>
        <Link href="/login">Member access</Link>
      </footer>
    </main>
  );
}
