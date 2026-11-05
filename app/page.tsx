import type { Metadata } from "next";
import Image from "next/image";
import { ArrowRight, ChevronDown, Leaf } from "lucide-react";
import styles from "./home.module.css";

export const metadata: Metadata = {
  title: "FretGone — A community you shape. A place that feels yours.",
  description:
    "Every owner has a voice. FretGone handles the conversations, coordination, and everyday follow-through behind your HOA. From $200 per community per month. First month free.",
  openGraph: {
    title: "FretGone — A community you shape.",
    description:
      "Self-governance. Without the administrative burden. HOA coordination from $200/month. First month free.",
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
const email = "mailto:contact@fretgone.com";

export default function Home() {
  return (
    <div className={styles.site}>
      <a className={styles.skip} href="#main">
        Skip to content
      </a>
      <header className={styles.header}>
        <a className={styles.brand} href="/" aria-label="FretGone home">
          fretgone<span>.</span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#service">The service</a>
          <a href="#pricing">Pricing</a>
          <a href={email}>Contact</a>
        </nav>
        <a className={styles.headerCta} href={email}>
          First month free <ArrowRight size={15} />
        </a>
      </header>
      <main id="main">
        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={styles.heroArt}>
            <Image
              className={styles.heroImage}
              src="/images/community-open-gate.webp"
              alt="A homeowner opens her garden gate toward a sunlit neighborhood where people are enjoying their own daily lives."
              fill
              priority
              sizes="(max-width: 760px) 100vw, 76vw"
            />
          </div>
          <div className={styles.heroVeil} />
          <div className={styles.heroContent}>
            <p className={styles.eyebrow}>HOA COORDINATION, DONE FOR YOU</p>
            <h1 id="hero-title">
              A community <br />
              you shape.
              <span>
                A place that <br />
                feels yours.
              </span>
            </h1>
            <p className={styles.heroDescription}>
              Every owner deserves a voice in what happens next. We bring those
              voices together—and take the coordination off your board’s hands.
            </p>
            <p className={styles.heroPromise}>
              Self-governance.
              <br className={styles.mobileBreak} /> Without the administrative
              burden.
            </p>
            <a className={styles.button} href={email}>
              Start with a free month <ArrowRight size={18} />
            </a>
            <p className={styles.heroNote}>
              Familiar text & email. No new homeowner accounts.
            </p>
          </div>
        </section>
        <section
          id="pricing"
          className={styles.priceBar}
          aria-label="HOA service pricing"
        >
          <div className={styles.basePrice}>
            <strong>
              $200<span>/month</span>
            </strong>
            <span>For your entire HOA · under 500 homes</span>
          </div>
          <div className={styles.largePrice}>
            <strong>500–999 homes: $500/month</strong>
            <span>1,000+ homes: not currently available</span>
          </div>
          <a href={email}>
            Your first month is on us <ArrowRight size={18} />
          </a>
        </section>

        <section id="service" className={styles.section}>
          <div className={styles.sectionHeading}>
            <p className={styles.eyebrow}>
              MORE VOICE. LESS WEIGHT ON YOUR SHOULDERS.
            </p>
            <h2>
              Being part of a community
              <br />
              shouldn’t be a second job.
            </h2>
            <p>
              Owners keep reaching out by text and email. We handle the
              listening, the back-and-forth, and the next steps—so participation
              leads somewhere.
            </p>
          </div>
          <div className={styles.steps}>
            <article>
              <span>01 / LISTEN</span>
              <h3>Every owner heard.</h3>
              <p>
                Gather views and ask the follow-up questions. Give people room
                to participate, without making everyone attend another meeting.
              </p>
            </article>
            <article>
              <span>02 / FIND COMMON GROUND</span>
              <h3>A way forward, together.</h3>
              <p>
                Work toward proposals people can agree on. When views differ,
                preserve the concerns and the path the conversation took.
              </p>
            </article>
            <article>
              <span>03 / CARRY IT THROUGH</span>
              <h3>Less left on the board.</h3>
              <p>
                Handle authorized routine follow-through. Bring sensitive steps
                to a board member for approval, with a clear record of what
                happens.
              </p>
            </article>
          </div>
        </section>

        <section className={styles.setup}>
          <div className={styles.setupInner}>
            <span className={styles.setupMark}>
              <Leaf size={33} strokeWidth={1.1} />
            </span>
            <div>
              <p className={styles.eyebrow}>A SIMPLE BEGINNING</p>
              <h2>
                One board member.
                <br />
                About ten minutes to get started.
              </h2>
              <p>
                A short setup conversation to authorize your channels and agree
                on boundaries. We confirm your existing tools, journal access,
                and approval workflow together.
              </p>
            </div>
            <a href={email} className={styles.textLink}>
              Talk through your setup <ArrowRight size={17} />
            </a>
          </div>
        </section>

        <section className={`${styles.section} ${styles.faq}`}>
          <div>
            <p className={styles.eyebrow}>CONFIDENCE COMES FROM CLARITY</p>
            <h2>
              Your community.
              <br />
              Your say.
            </h2>
            <p className={styles.faqIntro}>
              We take on the work.
              <br />
              Your board keeps its authority.
            </p>
            <a className={styles.textLink} href={email}>
              Ask us anything <ArrowRight size={17} />
            </a>
          </div>
          <div className={styles.questions}>
            <details>
              <summary>
                Are we buying software or a service?
                <ChevronDown size={17} />
              </summary>
              <p>
                A service that does the work: homeowner conversations,
                coordination, documentation, and authorized follow-through.
                Owners keep using text and email. There is no new FretGone app
                or account for them to learn.
              </p>
            </details>
            <details>
              <summary>
                How does the board stay informed?
                <ChevronDown size={17} />
              </summary>
              <p>
                A board-only Notion journal brings together discussions,
                decisions, progress, and unresolved concerns. Board members can
                read it without a Notion signup; controlled access is arranged
                during setup. Private homeowner messages are not shared with
                other homeowners.
              </p>
            </details>
            <details>
              <summary>
                What needs our approval?
                <ChevronDown size={17} />
              </summary>
              <p>
                We agree on permissions before starting. Sensitive actions, such
                as spending money or placing orders, are intended to come to a
                board member’s phone for approval or rejection. Your board
                retains its responsibilities; a conversation does not replace
                your association’s required decision process.
              </p>
            </details>
            <details>
              <summary>
                Can we keep the tools we already use?
                <ChevronDown size={17} />
              </summary>
              <p>
                Yes—that is the intended setup. A browser agent on a designated,
                available board computer reads tasks from the journal and works
                in your existing email, HOA, and accounting tools. Compatibility
                and phone approvals are confirmed before starting. Routine work
                is intended to run without someone watching the screen.
              </p>
            </details>
            <details>
              <summary>
                How are privacy and records protected?
                <ChevronDown size={17} />
              </summary>
              <p>
                We review access, retention, provider data flows, and approval
                controls before connecting channels. AWS-backed tamper-evident
                archiving is an option to confirm; Notion alone is not
                immutable. Browser safeguards depend on the selected tools and
                configuration. We explain the actual setup rather than promise
                absolute protection.
              </p>
            </details>
          </div>
        </section>
        <section className={styles.closing}>
          <p className={styles.eyebrow}>
            A LITTLE LESS TO CARRY. A LITTLE MORE ROOM TO LIVE.
          </p>
          <h2>
            Make room for the community
            <br />
            you want to call home.
          </h2>
          <a className={styles.button} href={email}>
            Let’s start a conversation <ArrowRight size={18} />
          </a>
          <a className={styles.contactEmail} href={email}>
            contact@fretgone.com
          </a>
        </section>
      </main>
      <footer className={styles.footer}>
        <div>
          <a className={styles.brand} href="/">
            fretgone.
          </a>
          <span>© {new Date().getFullYear()} FretGone LLC</span>
        </div>
        <nav aria-label="Legal">
          <a href="/about">About</a>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          <a href={email}>Contact</a>
        </nav>
      </footer>
    </div>
  );
}
