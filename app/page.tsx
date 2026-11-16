import type { Metadata } from "next";
import Image from "next/image";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import styles from "./home.module.css";

export const metadata: Metadata = {
  title: "WillingLink — Free HOA IDR & ADR",
  description:
    "Free IDR and ADR support for homeowners and HOA boards. Ongoing HOA mediation, homeowner feedback, and shared decision-making for $1 per unit per month.",
  openGraph: {
    title: "WillingLink — Free HOA IDR & ADR",
    description:
      "A dispute doesn’t have to define your community. Start with free IDR and ADR support. Ongoing HOA coordination is available separately for $1 per unit per month.",
    images: [
      {
        url: "/images/community-open-gate.webp",
        width: 1536,
        height: 1024,
        alt: "A homeowner opening a garden gate into her neighborhood.",
      },
    ],
  },
};
const email =
  "mailto:contact@fretgone.com?subject=Free%20IDR%20%2F%20ADR%20inquiry";

export default function Home() {
  return (
    <div className={styles.site}>
      <a className={styles.skip} href="#main">
        Skip to content
      </a>
      <header className={styles.header}>
        <a className={styles.brand} href="/" aria-label="WillingLink home">
          WillingLink<span>.</span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#resolution">Free IDR &amp; ADR</a>
          <a href="#ongoing">For HOAs</a>
          <a href="/careers">Work with us</a>
        </nav>
        <a className={styles.headerCta} href={email}>
          Get in touch <ArrowUpRight size={16} aria-hidden="true" />
        </a>
      </header>
      <main id="main">
        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={styles.heroContent}>
            <span className={styles.freeTag}>
              <span aria-hidden="true" />
              Free. No subscription required.
            </span>
            <h1 id="hero-title">
              Free IDR <span>&amp; ADR.</span>
            </h1>
            <p className={styles.heroLead}>You still have to be neighbors.</p>
            <p className={styles.heroDescription}>
              When homeowners and the board disagree, there should be a place to
              start. We help people explain their concerns, explore options, and
              work toward a resolution.
            </p>
            <a className={styles.button} href={email}>
              Let’s talk it through <ArrowRight size={18} aria-hidden="true" />
            </a>
            <p className={styles.heroNote}>For homeowners and HOA boards.</p>
          </div>
          <div className={styles.heroArt}>
            <Image
              className={styles.heroImage}
              src="/images/community-open-gate.webp"
              alt="A homeowner opens her garden gate onto a sunlit neighborhood."
              fill
              priority
              sizes="(max-width: 760px) 100vw, 48vw"
            />
            <div className={styles.imageCaption}>
              A disagreement is part of the story.
              <br />
              It doesn’t have to be the whole story.
            </div>
          </div>
        </section>

        <section
          id="resolution"
          className={styles.resolution}
          aria-labelledby="resolution-title"
        >
          <div className={styles.sectionIntro}>
            <p className={styles.eyebrow}>A WAY TO BEGIN</p>
            <h2 id="resolution-title">
              Less talking past each other.
              <br />
              More working through it.
            </h2>
          </div>
          <div className={styles.resolutionGrid}>
            <article>
              <div className={styles.serviceLabel}>
                <span>IDR</span>
                <span className={styles.freeLabel}>Free</span>
              </div>
              <h3>Start within your community.</h3>
              <p>
                Internal dispute resolution helps homeowners and their HOA
                discuss a disagreement directly. We help clarify the issues and
                keep the conversation moving.
              </p>
            </article>
            <article>
              <div className={styles.serviceLabel}>
                <span>ADR</span>
                <span className={styles.freeLabel}>Free</span>
              </div>
              <h3>Bring in another perspective.</h3>
              <p>
                Alternative dispute resolution offers a way to work through a
                dispute with neutral help. Our focus is mediation: hearing each
                side and exploring a resolution together.
              </p>
            </article>
          </div>
          <div className={styles.startLine}>
            <span>
              Start with an email. Tell us what happened and what you’d like to
              resolve.
            </span>
            <a className={styles.textLink} href={email}>
              contact@fretgone.com <ArrowUpRight size={16} aria-hidden="true" />
            </a>
          </div>
        </section>

        <section
          id="ongoing"
          className={styles.ongoing}
          aria-labelledby="ongoing-title"
        >
          <div className={styles.ongoingIntro}>
            <p className={styles.eyebrow}>ONGOING HOA COORDINATION</p>
            <h2 id="ongoing-title">Keep the conversation going.</h2>
            <p>
              For the everyday issues that need more than a one-time
              conversation.
            </p>
            <ul>
              <li>Collect homeowner feedback</li>
              <li>Work through disagreements as they arise</li>
              <li>Help the community make decisions together</li>
            </ul>
          </div>
          <div className={styles.ongoingPrice}>
            <p>
              <strong>$1</strong>
              <span> / unit / month</span>
            </p>
            <span>Billed to your HOA based on its total unit count.</span>
            <a
              className={styles.textLink}
              href="mailto:contact@fretgone.com?subject=Ongoing%20HOA%20coordination"
            >
              Talk about your HOA <ArrowUpRight size={16} aria-hidden="true" />
            </a>
          </div>
        </section>
        <aside className={styles.joinLine}>
          <p>Good at helping people hear each other?</p>
          <a className={styles.textLink} href="/careers">
            Explore ongoing opportunities{" "}
            <ArrowUpRight size={17} aria-hidden="true" />
          </a>
        </aside>
      </main>
      <footer className={styles.footer}>
        <div>
          <a className={styles.brand} href="/">
            WillingLink<span>.</span>
          </a>
          <span>© {new Date().getFullYear()} FretGone LLC</span>
        </div>
        <nav aria-label="Footer navigation">
          <a href="/careers">Work with us</a>
          <a href="mailto:contact@fretgone.com">Contact</a>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
        </nav>
      </footer>
    </div>
  );
}
