import type { Metadata } from "next";
import Image from "next/image";
import { ArrowRight, ChevronDown, Leaf } from "lucide-react";
import styles from "./home.module.css";

export const metadata: Metadata = {
  title: "FretGone — Self-governance. Without the self-sacrifice.",
  description:
    "We take on your HOA board’s daily work. Owners participate by text and email. From $200/month for the whole HOA. First month free.",
  openGraph: {
    title: "FretGone — Self-governance. Without the self-sacrifice.",
    description:
      "Your board’s daily work, taken care of. Owner views gathered. Disagreements recorded. From $200/month for the whole HOA. First month free.",
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
              THE HOA’S WORK. TAKEN OFF YOUR HANDS.
            </p>
            <h1 id="hero-title">
              Self-governance.
              <span>
                Without the <br />
                <span className={styles.noWrap}>self-sacrifice.</span>
              </span>
            </h1>
            <p className={styles.heroDescription}>
              Owners contact the board by text or email, as usual. With your
              authorization, we receive those messages, discuss proposals with
              owners, and carry out approved work.
            </p>
            <p className={styles.heroPromise}>
              From $200/month. For the whole HOA.
            </p>
            <a className={styles.button} href={email}>
              Email us to get started <ArrowRight size={18} />
            </a>
            <p className={styles.heroNote}>
              First month free. No FretGone accounts required.
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
            <h2>How the service works.</h2>
          </div>
          <div className={styles.steps}>
            <article>
              <span>01 / ASK</span>
              <h3>We gather owners’ views.</h3>
              <p>
                We receive messages through your board’s authorized channels and
                follow up with owners to understand their concerns.
              </p>
            </article>
            <article>
              <span>02 / DISCUSS</span>
              <h3>We work toward agreement.</h3>
              <p>
                We discuss proposals with owners and look for a plan everyone
                can accept. If differences remain, we record the discussion and
                unresolved points.
              </p>
            </article>
            <article>
              <span>03 / ACT</span>
              <h3>We carry out approved work.</h3>
              <p>
                Routine tasks run within the permissions you set. Spending,
                orders, and other sensitive actions go to a board member’s phone
                for approval or rejection.
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
              <h2>
                One board member.
                <br />
                About ten minutes to begin.
              </h2>
              <p>
                One member authorizes your board’s email and text channels.
                Together, we check your existing tools, set permissions, and
                arrange journal access and phone approvals.
              </p>
            </div>
            <a href={email} className={styles.textLink}>
              Discuss your setup <ArrowRight size={17} />
            </a>
          </div>
        </section>

        <section className={`${styles.section} ${styles.faq}`}>
          <div>
            <h2>
              Our mistakes belong <br />
              in the record.
            </h2>
            <p className={styles.faqIntro}>
              We keep a Notion journal for your board: what owners raised, what
              was discussed, what was decided, and what we did—including
              problems and unfinished work.
            </p>
            <a className={styles.textLink} href={email}>
              Ask us anything <ArrowRight size={17} />
            </a>
          </div>
          <div className={styles.questions}>
            <details>
              <summary>
                What does the service take over?
                <ChevronDown size={17} />
              </summary>
              <p>
                Owner correspondence, gathering views, developing proposals,
                keeping records, and carrying out authorized tasks. Your board
                sets the scope and reviews sensitive actions.
              </p>
            </details>
            <details>
              <summary>
                Who can read the journal?
                <ChevronDown size={17} />
              </summary>
              <p>
                The journal is for board members, who can read it without
                creating a Notion account. Private owner messages are not shared
                with other owners.
              </p>
            </details>
            <details>
              <summary>
                What needs our approval?
                <ChevronDown size={17} />
              </summary>
              <p>
                Spending, orders, and other sensitive actions. A board member
                reads the proposed action on their phone and approves or
                declines it. We confirm this flow before starting. Your HOA’s
                voting rules and board responsibilities still apply.
              </p>
            </details>
            <details>
              <summary>
                Can we keep the tools we already use?
                <ChevronDown size={17} />
              </summary>
              <p>
                The proposed setup uses a browser agent on a board computer to
                read tasks from the journal and work in your existing email,
                HOA, and accounting websites. The computer must stay available;
                you don’t need to watch it. We confirm compatibility first.
              </p>
            </details>
            <details>
              <summary>
                How do you protect the record?
                <ChevronDown size={17} />
              </summary>
              <p>
                Notion pages can be edited. A separate AWS-backed archive can
                help make later changes detectable. We confirm its availability
                and coverage, along with who can access and process your data
                and how long it is kept, before connecting accounts.
              </p>
            </details>
          </div>
        </section>
        <section className={styles.closing}>
          <h2>
            You live here. <br />
            You should get to enjoy it.
          </h2>
          <a className={styles.button} href={email}>
            Contact us <ArrowRight size={18} />
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
