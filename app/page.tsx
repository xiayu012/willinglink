import type { Metadata } from "next";
import Image from "next/image";
import { ArrowRight, ChevronDown, Leaf } from "lucide-react";
import styles from "./home.module.css";

export const metadata: Metadata = {
  title: "FretGone — Your community. Your say. We do the work.",
  description:
    "Your HOA belongs to its owners. We gather their views, work toward agreement, and take on the everyday work. $200/month for HOAs under 500 homes. First month free.",
  openGraph: {
    title: "FretGone — Your community. Your say.",
    description:
      "Owners shape the decisions. We handle the work. The board can see the record. HOA service from $200/month. First month free.",
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
            <p className={styles.eyebrow}>
              SELF-GOVERNANCE, WITHOUT THE BUSYWORK.
            </p>
            <h1 id="hero-title">
              Your community. <br />
              Your say.
              <span>We do the work.</span>
            </h1>
            <p className={styles.heroDescription}>
              Your HOA belongs to its owners. We listen to them, work toward
              agreement, and handle the everyday work—so your board doesn’t have
              to.
            </p>
            <p className={styles.heroPromise}>
              The work changes hands.
              <br className={styles.mobileBreak} /> The power stays yours.
            </p>
            <a className={styles.button} href={email}>
              Try the first month free <ArrowRight size={18} />
            </a>
            <p className={styles.heroNote}>
              Keep texting. Keep emailing. No new accounts.
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
            First month free <ArrowRight size={18} />
          </a>
        </section>

        <section id="service" className={styles.section}>
          <div className={styles.sectionHeading}>
            <p className={styles.eyebrow}>A SAY THAT LEADS SOMEWHERE.</p>
            <h2>
              An opinion should do more <br />
              than sit in an inbox.
            </h2>
            <p>
              We do the work between “here’s what I think” and “here’s what
              happens next.” Listening. Finding agreement. Getting things done.
            </p>
          </div>
          <div className={styles.steps}>
            <article>
              <span>01 / HEAR PEOPLE OUT</span>
              <h3>Every owner has a say.</h3>
              <p>
                We collect owners’ views by text and email, then ask the
                follow-up questions. Participation shouldn’t depend on who can
                attend a meeting.
              </p>
            </article>
            <article>
              <span>02 / WORK TOWARD AGREEMENT</span>
              <h3>Disagreement counts, too.</h3>
              <p>
                We look for a proposal everyone can accept. If we can’t get
                there, we record what was discussed and what remains unresolved.
                No invented consensus.
              </p>
            </article>
            <article>
              <span>03 / DO THE WORK</span>
              <h3>Your board can step back.</h3>
              <p>
                We handle the replies, coordination, and tasks you authorize.
                Spending and other sensitive actions go to a board member for
                review. Routine work shouldn’t need a full-time volunteer.
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
              <p className={styles.eyebrow}>SMALL SETUP. REAL RELIEF.</p>
              <h2>
                One board member.
                <br />
                About ten minutes to begin.
              </h2>
              <p>
                Connect your board’s email and text channels. Agree on what we
                can do and what needs approval. We check your tools with you
                before starting.
              </p>
            </div>
            <a href={email} className={styles.textLink}>
              Let’s talk setup <ArrowRight size={17} />
            </a>
          </div>
        </section>

        <section className={`${styles.section} ${styles.faq}`}>
          <div>
            <p className={styles.eyebrow}>TRANSPARENCY INCLUDES US.</p>
            <h2>
              See the work. <br />
              Question it.
            </h2>
            <p className={styles.faqIntro}>
              Your board gets a journal of discussions, decisions, open
              questions, and our actions. You should be able to judge our work
              by the record.
            </p>
            <a className={styles.textLink} href={email}>
              Ask us anything <ArrowRight size={17} />
            </a>
          </div>
          <div className={styles.questions}>
            <details>
              <summary>
                What are we paying for?
                <ChevronDown size={17} />
              </summary>
              <p>
                The work itself: talking with owners, finding agreement, keeping
                records, and carrying out approved tasks. You’re hiring help,
                not taking on another system to manage. Owners and board members
                don’t need FretGone accounts.
              </p>
            </details>
            <details>
              <summary>
                Who can read the journal?
                <ChevronDown size={17} />
              </summary>
              <p>
                The journal is for your board. Members can read it without a
                Notion account; we arrange access during setup. An owner’s
                private texts and emails are not published to other owners.
              </p>
            </details>
            <details>
              <summary>
                What needs our approval?
                <ChevronDown size={17} />
              </summary>
              <p>
                We agree on limits first. The setup is designed to send
                spending, orders, and other sensitive actions to a board
                member’s phone: read, then approve or decline. We confirm that
                flow before starting. Your HOA’s voting rules and board
                responsibilities still apply.
              </p>
            </details>
            <details>
              <summary>
                Can we keep the tools we already use?
                <ChevronDown size={17} />
              </summary>
              <p>
                That’s the plan. A browser agent works on a board computer in
                your existing email, HOA, and accounting websites. The computer
                needs to stay available, not attended. We check compatibility
                before connecting your tools.
              </p>
            </details>
            <details>
              <summary>
                Can the record be changed? What about privacy?
                <ChevronDown size={17} />
              </summary>
              <p>
                A Notion page alone can be edited. An AWS-backed archive can
                help make changes detectable; we confirm its availability and
                scope before offering that protection. Before connecting
                accounts, we also explain who can access the data, which
                providers process it, and how long it is kept.
              </p>
            </details>
          </div>
        </section>
        <section className={styles.closing}>
          <p className={styles.eyebrow}>YOUR HOME. YOUR NEIGHBORS. YOUR SAY.</p>
          <h2>
            Self-governance should work. <br />
            It shouldn’t be your second job.
          </h2>
          <a className={styles.button} href={email}>
            Put us to work <ArrowRight size={18} />
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
