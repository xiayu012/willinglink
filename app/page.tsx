import type { Metadata } from "next";
import Image from "next/image";
import { ArrowRight, ChevronDown, X } from "lucide-react";
import styles from "./home.module.css";
import { IdrIntakePreview } from "./idr-intake-preview";

export const metadata: Metadata = {
  title: "FretGone — Free HOA IDR & ADR",
  description:
    "Free IDR and ADR support for homeowners and HOA. Ongoing HOA mediation, homeowner feedback, and shared decision-making for $1 per unit per month.",
  openGraph: {
    title: "FretGone — Free HOA IDR & ADR",
    description:
      "Free IDR and ADR support for homeowners and HOA. Ongoing HOA coordination is available separately for $1 per unit per month.",
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

export default function Home() {
  return (
    <div className={styles.site}>
      <a className={styles.skip} href="#main">
        Skip to content
      </a>
      <header className={styles.header}>
        <a className={styles.brand} href="/" aria-label="FretGone home">
          FretGone<span>.</span>
        </a>
        <nav aria-label="Main navigation">
          <a href="/careers">Careers</a>
        </nav>
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
              homeowners and HOA.
            </p>
            <div className={styles.freeActions}>
              <div className={styles.servicePath}>
                <a className={styles.serviceButton} href="#idr-preview">
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
                <a className={styles.serviceButton} href="#adr-preview">
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
          <ul className={styles.serviceFeatures}>
            <li>Unlimited IDR &amp; ADR</li>
            <li>Collect homeowner feedback</li>
            <li>Help the community make decisions together</li>
            <li>Send the HOA a consolidated summary</li>
          </ul>
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
      <section
        id="idr-preview"
        className={styles.idrPreview}
        aria-label="IDR preview"
      >
        <a
          href="#resolution"
          className={styles.idrClose}
          aria-label="Close IDR preview"
        >
          <X size={36} aria-hidden="true" />
        </a>
        <div className={styles.idrPanel}>
          <ol className={styles.idrProgress}>
            <li aria-current="step" aria-label="Step 1" />
            <li>
              <span>Prepare your request</span>
            </li>
            <li>
              <span>Talk with your HOA</span>
            </li>
          </ol>
          <IdrIntakePreview subject="Formal IDR Request" />
        </div>
      </section>
      <section
        id="adr-preview"
        className={styles.idrPreview}
        aria-label="ADR preview"
      >
        <a
          href="#resolution"
          className={styles.idrClose}
          aria-label="Close ADR preview"
        >
          <X size={36} aria-hidden="true" />
        </a>
        <div className={styles.idrPanel}>
          <ol className={styles.idrProgress}>
            <li aria-current="step" aria-label="Step 1" />
            <li>
              <span>Prepare your request</span>
            </li>
            <li>
              <span>Explore a way forward</span>
            </li>
          </ol>
          <IdrIntakePreview mode="adr" subject="Formal ADR Request" />
        </div>
      </section>
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
              <h3>Send an Email</h3>
              <p>FretGone prepares your IDR email. All you need to do is add your HOA’s email address and click Send.</p>
            </li>
            <li>
              <h3>Wait for Your HOA to Respond</h3>
              <p>Response times depend on state law and your HOA’s IDR policy.</p>
            </li>
            <li>
              <h3>Explain Your Case</h3>
              <p>After your HOA agrees to IDR, one of our volunteers will email you. Reply to that email with what happened and what you’d like to achieve.</p>
            </li>
            <li>
              <h3>FretGone Negotiates for You</h3>
              <p>FretGone handles the back-and-forth with your HOA to work toward a solution. We’ll ask for your input when needed.</p>
            </li>
            <li>
              <h3>Agreement or ADR</h3>
              <p>If both sides agree, FretGone will email the agreement for you and your HOA to e-sign. Otherwise, we’ll help you explore alternative dispute resolution (ADR).</p>
            </li>
          </ol>
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
              <h3>Prepare your request</h3>
              <p>We help prepare a request describing the dispute and asking for ADR.</p>
            </li>
            <li>
              <h3>Send it to your HOA</h3>
              <p>Use the delivery method required for your request.</p>
            </li>
            <li>
              <h3>Wait for a response</h3>
              <p>In California, a qualifying request is declined if not accepted within 30 days.</p>
            </li>
            <li>
              <h3>Meet with a mediator</h3>
              <p>If both sides proceed, a neutral mediator helps explore a solution. Record the outcome.</p>
            </li>
          </ol>
        </div>
      </div>
      <footer className={styles.footer}>
        <div>
          <a className={styles.brand} href="/">
            FretGone<span>.</span>
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
