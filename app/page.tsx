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
              We take on your board’s daily work. Owners keep texting and
              emailing. We gather their views, work toward agreement, and carry
              out approved decisions.
            </p>
            <p className={styles.heroPromise}>
              From $200/month. For the whole HOA.
            </p>
            <a className={styles.button} href={email}>
              Try us. First month free. <ArrowRight size={18} />
            </a>
            <p className={styles.heroNote}>No new accounts. No app to learn.</p>
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
            <h2>
              A text can start <br />a community decision.
            </h2>
          </div>
          <div className={styles.steps}>
            <article>
              <span>01 / ASK</span>
              <h3>Beyond the meeting room.</h3>
              <p>
                We reach out to owners and gather their views by text and email.
                Having a say shouldn’t require an evening at a meeting.
              </p>
            </article>
            <article>
              <span>02 / RESOLVE</span>
              <h3>Agreement takes work.</h3>
              <p>
                We work toward a proposal everyone can accept. When people still
                disagree, the record says so.
              </p>
            </article>
            <article>
              <span>03 / ACT</span>
              <h3>Approval. From your phone.</h3>
              <p>
                We handle the routine work. Spending and other sensitive steps
                need a board member’s approval. Read. Approve or decline.
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
                Authorize your email and text channels. Set our limits. We check
                your existing tools before starting.
              </p>
            </div>
            <a href={email} className={styles.textLink}>
              Start here <ArrowRight size={17} />
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
              Your board’s journal records the discussions, decisions, and our
              actions—including problems and unfinished work.
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
                Replies, owner conversations, proposals, records, and approved
                tasks. We do them. Owners keep using text and email. No FretGone
                accounts required.
              </p>
            </details>
            <details>
              <summary>
                Who can read the journal?
                <ChevronDown size={17} />
              </summary>
              <p>
                Board members, without a Notion signup. We arrange access at
                setup. Owners’ private messages stay out of other owners’ view.
              </p>
            </details>
            <details>
              <summary>
                What needs our approval?
                <ChevronDown size={17} />
              </summary>
              <p>
                Spending, orders, and other actions outside the limits we agree
                on. We confirm phone approvals at setup. Your HOA’s voting rules
                and board responsibilities still apply.
              </p>
            </details>
            <details>
              <summary>
                Can we keep the tools we already use?
                <ChevronDown size={17} />
              </summary>
              <p>
                We check compatibility first. The setup uses a browser agent on
                an available board computer to work in your email, HOA, and
                accounting websites. You don’t have to sit at the screen.
              </p>
            </details>
            <details>
              <summary>
                How do you protect the record?
                <ChevronDown size={17} />
              </summary>
              <p>
                Notion pages can be edited. AWS-backed archiving can help expose
                changes; availability and coverage must be confirmed before we
                promise that protection. We also explain data access,
                processing, and retention before connecting accounts.
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
            Give us the work <ArrowRight size={18} />
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
