import type { Metadata } from "next";
import Image from "next/image";
import { ArrowRight, ChevronDown, Leaf } from "lucide-react";
import styles from "./home.module.css";

export const metadata: Metadata = {
  title: "WillingLink — Self-managed HOAs, without the self-sacrifice.",
  description:
    "Make your HOA easier to self-manage, with less reliance on costly management companies. One monthly HOA payment: $20 for up to 20 owners, plus $1 for each additional owner. First month free.",
  openGraph: {
    title: "WillingLink — Self-managed HOAs, without the self-sacrifice.",
    description:
      "WillingLink helps you move beyond property management companies and makes self-management easier. We take on the conversations, proposals, and daily follow-through. One monthly HOA payment: $20 for up to 20 owners, plus $1 for each additional owner. First month free.",
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
          <a href="#service">How it works</a>
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
            <p className={styles.eyebrow}>FOR SELF-MANAGED HOAS</p>
            <h1 id="hero-title">
              Self-management.
              <span>
                Without the <br />
                <span className={styles.noWrap}>self-sacrifice.</span>
              </span>
            </h1>
            <p className={styles.heroDescription}>
              WillingLink helps you move beyond property management companies
              and makes self-management easier. We handle owner conversations,
              proposals, and daily follow-through—making self-management a
              practical alternative to high management fees.
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
          className={styles.pricingBand}
          aria-label="HOA pricing"
        >
          <div className={styles.pricingInner}>
            <div className={styles.pricingBase}>
              <p className={styles.pricingAmount}>
                <span className={styles.pricingNumber}>
                  $20
                  <svg
                    className={styles.pricingStroke}
                    viewBox="0 0 160 16"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <path d="M4 10C48 0 108 0 157 8C111 4 56 6 6 15C2 16 0 12 4 10Z" />
                  </svg>
                </span>
                <span>/month per HOA</span>
              </p>
              <span className={styles.pricingCaption}>Up to 20 owners</span>
            </div>
            <div className={styles.pricingDetails}>
              <p className={styles.pricingExtra}>
                +$1/month for each additional owner
              </p>
              <p className={styles.pricingFootnote}>
                One payment from your HOA. First month free.
              </p>
            </div>
          </div>
        </section>

        <section id="service" className={styles.section}>
          <div className={styles.sectionHeading}>
            <h2>How we make self-management easier.</h2>
          </div>
          <div className={styles.steps}>
            <article>
              <span>01 / ASK</span>
              <h3>Owners have their say.</h3>
              <p>
                Owners keep using text and email. ChatGPT gathers their views
                and asks follow-up questions through the accounts your board
                authorizes.
              </p>
            </article>
            <article>
              <span>02 / DISCUSS</span>
              <h3>A plan everyone can live with.</h3>
              <p>
                The AI discusses ideas with owners and revises the plan until
                everyone can accept it—or records where and why people still
                disagree.
              </p>
            </article>
            <article>
              <span>03 / ACT</span>
              <h3>Approved work gets done.</h3>
              <p>
                The AI handles routine tasks within the limits your board sets.
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
                Your existing tools stay as they are. We help your board add a
                ChatGPT browser extension and WillingLink for owner texts and
                emails. Your board grants account access to ChatGPT.
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
              Your board can read the whole history: what people said, what was
              decided, what the AI did in your browser, and what happened next.
              Nothing is deleted.
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
                Your board authorizes ChatGPT through the selected tool’s access
                controls. This account authorization is not granted to FretGone.
                We confirm permissions and data handling during setup.
              </p>
            </details>
            <details>
              <summary>
                What does WillingLink do for a self-managed HOA?
                <ChevronDown size={17} />
              </summary>
              <p>
                WillingLink helps boards manage their own HOAs. It handles owner
                texts and emails, keeps discussions and follow-ups moving, and
                records the work. The browser extension carries out authorized
                tasks in your existing tools. Your board sets the limits and
                approves sensitive actions. We currently serve HOAs with fewer
                than 1,000 homes.
              </p>
            </details>
            <details>
              <summary>
                Who can see the work log?
                <ChevronDown size={17} />
              </summary>
              <p>
                Board members can read the service’s work log on a Notion page
                without creating a Notion account. It includes owner
                discussions, decisions, and the AI’s browser actions. Private
                owner messages are not shared with other owners.
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
                Yes. Your email, HOA software, accounting tools, and everything
                else stay as they are. We add only a ChatGPT browser extension
                and WillingLink to handle incoming owner texts and emails.
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
