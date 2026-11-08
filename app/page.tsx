import type { Metadata } from "next";
import Image from "next/image";
import { ArrowRight, ChevronDown, Leaf } from "lucide-react";
import styles from "./home.module.css";

export const metadata: Metadata = {
  title: "WillingLink — Self-governance. Without the self-sacrifice.",
  description:
    "HOA work handled from owner conversations through to approved action. ChatGPT or Claude uses the accounts your board authorizes. From $200/month. First month free.",
  openGraph: {
    title: "WillingLink — Self-governance. Without the self-sacrifice.",
    description:
      "We take on the conversations, proposals, and follow-through—so your HOA can run without running your board into the ground. From $200/month for the whole HOA. First month free.",
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
        <a className={styles.brand} href="/" aria-label="WillingLink home">
          WillingLink
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
              We take on the conversations, proposals, and follow-through—so
              your HOA can run without running your board into the ground.
            </p>
            <p className={styles.heroPromise}>
              From $200/month. For the whole HOA.
            </p>
            <a className={styles.button} href={email}>
              Email us to get started <ArrowRight size={18} />
            </a>
            <p className={styles.heroNote}>
              First month free. No WillingLink accounts required.
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
              <h3>Owners have their say.</h3>
              <p>
                ChatGPT or Claude reads and replies through the accounts your
                board authorizes, gathering owners’ views and asking follow-up
                questions.
              </p>
            </article>
            <article>
              <span>02 / DISCUSS</span>
              <h3>A plan everyone can live with.</h3>
              <p>
                The agent discusses ideas with owners and revises the plan until
                everyone can accept it—or records where and why people still
                disagree.
              </p>
            </article>
            <article>
              <span>03 / ACT</span>
              <h3>Approved work gets done.</h3>
              <p>
                The agent handles routine tasks within the limits you set.
                Spending, orders, and other sensitive actions go to a board
                member’s phone for approval or rejection.
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
                One member grants ChatGPT or Claude access to the board’s text
                and email accounts. We help your board get the workflow,
                journal, and phone approvals set up, and check compatibility
                with your existing tools.
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
              Every step. <br />
              Kept on record.
            </h2>
            <p className={styles.faqIntro}>
              Your board’s Notion journal records the conversations, decisions,
              actions, and outcomes as they happen. New entries add to the
              history; earlier entries stay.
            </p>
            <a className={styles.textLink} href={email}>
              Ask us anything <ArrowRight size={17} />
            </a>
          </div>
          <div className={styles.questions}>
            <details>
              <summary>
                Who gets access to our text and email?
                <ChevronDown size={17} />
              </summary>
              <p>
                Your board authorizes ChatGPT or Claude through the selected
                tool’s access controls. This account authorization is not
                granted to FretGone. We confirm permissions and data handling
                during setup.
              </p>
            </details>
            <details>
              <summary>
                What does the service take over?
                <ChevronDown size={17} />
              </summary>
              <p>
                We help your board set up the tools. From there, the service
                handles incoming messages, proposals, records, and approved
                tasks as new work comes in. ChatGPT or Claude uses the accounts
                you authorize; your board sets the limits and approves sensitive
                actions.
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
                The proposed setup uses a ChatGPT or Claude agent on a board
                computer. It reads tasks from the journal and works in the
                email, HOA, and accounting websites you authorize. The computer
                must stay available; you don’t need to watch it. We confirm
                compatibility first.
              </p>
            </details>
            <details>
              <summary>
                How do you protect the record?
                <ChevronDown size={17} />
              </summary>
              <p>
                Notion pages can be edited. A separate AWS-backed archive can
                help make later changes detectable. We confirm archive coverage
                and review the selected AI tool’s account permissions, data
                access, processing, and retention before setup.
              </p>
            </details>
          </div>
        </section>
      </main>
      <footer className={styles.footer}>
        <div>
          <a className={styles.brand} href="/">
            WillingLink
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
