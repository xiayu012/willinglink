import type { Metadata } from "next";
import Image from "next/image";
import { ArrowRight, ArrowUpRight, ChevronDown, X } from "lucide-react";
import styles from "./home.module.css";

export const metadata: Metadata = {
  title: "WillingLink — Free HOA IDR & ADR",
  description:
    "Free IDR and ADR support for homeowners and HOA boards. Ongoing HOA mediation, homeowner feedback, and shared decision-making for $1 per unit per month.",
  openGraph: {
    title: "WillingLink — Free HOA IDR & ADR",
    description:
      "Free IDR and ADR support for homeowners and HOA boards. Ongoing HOA coordination is available separately for $1 per unit per month.",
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
          <a href="/careers">Careers</a>
        </nav>
        <a className={styles.headerCta} href={email}>
          Get in touch <ArrowUpRight size={16} aria-hidden="true" />
        </a>
      </header>
      <main id="main" className={styles.services} aria-label="Our two services">
        <section
          id="resolution"
          className={styles.freeService}
          aria-labelledby="hero-title"
        >
          <div className={styles.freeServiceContent}>
            <p className={styles.servicePrice}>Free</p>
            <h1 id="hero-title">IDR &amp; ADR.</h1>
            <p className={styles.serviceDescription}>
              We provide free internal dispute resolution (IDR) and
              mediation-based alternative dispute resolution (ADR) for
              homeowners and HOA boards.
            </p>
            <div className={styles.freeActions}>
              <div className={styles.servicePath}>
                <a
                  className={styles.serviceButton}
                  href="mailto:contact@fretgone.com?subject=Free%20IDR%20inquiry"
                >
                  Start My IDR <ArrowRight size={17} aria-hidden="true" />
                </a>
                <button
                  className={styles.stepsTrigger}
                  popoverTarget="idr-steps"
                  type="button"
                >
                  IDR steps <ChevronDown size={13} aria-hidden="true" />
                </button>
              </div>
              <div className={styles.servicePath}>
                <a
                  className={styles.serviceButton}
                  href="mailto:contact@fretgone.com?subject=Free%20ADR%20inquiry"
                >
                  Start My ADR <ArrowRight size={17} aria-hidden="true" />
                </a>
                <button
                  className={styles.stepsTrigger}
                  popoverTarget="adr-steps"
                  type="button"
                >
                  ADR steps <ChevronDown size={13} aria-hidden="true" />
                </button>
              </div>
            </div>
            <p className={styles.freeUseNote}>* One free case per homeowner.</p>
          </div>
        </section>
        <section
          id="ongoing"
          className={styles.paidService}
          aria-labelledby="ongoing-title"
        >
          <p className={styles.servicePrice}>
            <strong>$1</strong>
            <span> / unit / month</span>
          </p>
          <h2 id="ongoing-title">
            Ongoing HOA
            <br />
            mediation.
          </h2>
          <p className={styles.serviceDescription}>
            We collect homeowner feedback, mediate ongoing disagreements, and
            help the community make decisions together. We then send the board a
            consolidated summary.
          </p>
          <div className={styles.paidServiceAction}>
            <p>Billed to your HOA based on its total unit count.</p>
            <a
              className={styles.serviceButton}
              href="mailto:contact@fretgone.com?subject=Ongoing%20HOA%20coordination"
            >
              Contact us <ArrowRight size={18} aria-hidden="true" />
            </a>
          </div>
        </section>
        <div className={styles.servicePhoto}>
          <Image
            className={styles.servicePhotoImage}
            src="/images/community-open-gate.webp"
            alt="A homeowner opens her garden gate onto a sunlit neighborhood."
            fill
            priority
            sizes="(max-width: 760px) 100vw, (max-width: 1440px) 92vw, 1328px"
          />
        </div>
      </main>
      <div
        id="idr-steps"
        popover="auto"
        role="dialog"
        aria-labelledby="idr-steps-title"
        className={styles.stepsPopover}
      >
        <header className={styles.popoverHeader}>
          <div>
            <h2 id="idr-steps-title">IDR steps</h2>
          </div>
          <button
            type="button"
            popoverTarget="idr-steps"
            popoverTargetAction="hide"
            className={styles.closePopover}
            aria-label="Close IDR steps"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className={styles.popoverBody}>
          <ol className={styles.processList}>
            <li>
              <h3>Tell us what happened</h3>
              <p>
                Tell us the issue, your state, and what you’d like to resolve.
              </p>
            </li>
            <li>
              <h3>Prepare the next step</h3>
              <p>
                We check the applicable procedure, starting with your HOA’s own
                process, and help prepare your request.
              </p>
            </li>
            <li>
              <h3>Talk with your HOA</h3>
              <p>
                We help you prepare for the discussion and put any agreed next
                steps in writing.
              </p>
            </li>
          </ol>
          <details className={styles.processMore}>
            <summary>A few things to know</summary>
            <p className={styles.processContext}>
              The process depends on your state and HOA’s rules. We help you
              understand the next steps; your HOA handles its internal process.
              Where no compliant HOA procedure exists, the applicable legal
              fallback governs. Emailing us does not itself submit a formal
              request to your HOA.
            </p>
          </details>
        </div>
      </div>
      <div
        id="adr-steps"
        popover="auto"
        role="dialog"
        aria-labelledby="adr-steps-title"
        className={styles.stepsPopover}
      >
        <header className={styles.popoverHeader}>
          <div>
            <h2 id="adr-steps-title">ADR steps</h2>
          </div>
          <button
            type="button"
            popoverTarget="adr-steps"
            popoverTargetAction="hide"
            className={styles.closePopover}
            aria-label="Close ADR steps"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className={styles.popoverBody}>
          <ol className={styles.processList}>
            <li>
              <h3>Tell us what happened</h3>
              <p>
                Tell us the issue, your state, and what you’d like to resolve.
              </p>
            </li>
            <li>
              <h3>Send the formal request</h3>
              <p>
                We help prepare the request and explain how to send it under the
                applicable rules.
              </p>
            </li>
            <li>
              <h3>Explore a way forward</h3>
              <p>
                A neutral mediator helps both sides explore options. You choose
                whether to settle; any agreement is put in writing.
              </p>
            </li>
          </ol>
          <details className={styles.processMore}>
            <summary>A few things to know</summary>
            <p className={styles.processContext}>
              Required notices, timing, and mediator qualifications vary. We
              confirm whether our service fits before proceeding. Emailing us
              does not itself serve a legal notice or meet a filing deadline.
            </p>
          </details>
        </div>
      </div>
      <footer className={styles.footer}>
        <div>
          <a className={styles.brand} href="/">
            WillingLink<span>.</span>
          </a>
          <span>© {new Date().getFullYear()} FretGone LLC</span>
        </div>
        <nav aria-label="Footer navigation">
          <a href="/careers">Careers</a>
          <a href="mailto:contact@fretgone.com">Contact</a>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
        </nav>
      </footer>
    </div>
  );
}
